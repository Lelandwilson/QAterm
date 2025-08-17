#!/usr/bin/env node

// QA - AI Terminal Application
// A terminal-based AI assistant that connects to multiple providers

process.removeAllListeners('warning');

// Import required packages
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';
import boxen from 'boxen';
import ora from 'ora';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Anthropic } from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { Worker } from 'worker_threads';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import readline from 'readline';
import { startNewCodingProject } from './projectStarter.js';
import { startTui, startEditor } from './tui.js';

// Setup __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store the original installation directory
const installDir = __dirname;

// Save the caller's working directory
const callerDir = process.cwd();

// Startup mode flags (also exposed via Commander options)
const quietStart = process.argv.includes('--qs') || process.argv.includes('--quiet-start');
const fastAnswersMode = process.argv.includes('--fa') || process.argv.includes('--fast-answers');
const nvimHelpMode = process.argv.includes('--nvim') || process.argv.includes('--nvim-help');
const vocabMode = process.argv.includes('--vocab') || process.argv.includes('--vocabulary');

// Change to the caller's directory to operate from there (suppress in quiet mode)
if (!quietStart) {
  console.log(chalk.gray(`Starting from: ${callerDir}`));
}

// Load environment variables from .env file with absolute path (from installation directory)
dotenv.config({ path: path.join(installDir, '.env') });

// Initialize OpenRouter client (add this line)
let openRouter = null;
if (process.env.OPENROUTER_API_KEY) {
  // Using OpenAI client with OpenRouter base URL for compatibility
  openRouter = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://qaterm.app',  // Replace with your actual site
      'X-Title': 'QAterm'
    }
  });
}

// Track last outputs for copy actions
let lastAIResponse = '';
let sessionTranscript = [];

// Utility: strip ANSI sequences for clean copying
function stripAnsi(input) {
  if (!input) return '';
  // Regex covers color codes and some cursor control
  return input
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '') // OSC sequences
    .replace(/\x1B\[[\?0-9;]*[hl]/g, ''); // mode set/reset
}

// Best-effort clipboard copy across OSes
async function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    const cleaned = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    let cmd;
    if (platform === 'darwin') {
      cmd = 'pbcopy';
    } else if (platform === 'win32') {
      cmd = 'clip';
    } else {
      // Try xclip, then wl-copy
      cmd = 'bash -lc "(command -v xclip >/dev/null 2>&1 && xclip -selection clipboard) || (command -v wl-copy >/dev/null 2>&1 && wl-copy)"';
    }
    const child = exec(cmd, (err) => {
      if (err) {
        // Fallback: write to file so user can access
        try {
          const fallback = path.join(process.cwd(), 'clipboard.txt');
          fs.writeFileSync(fallback, cleaned, 'utf8');
          return resolve({ copied: false, fallback });
        } catch (e) {
          return reject(err);
        }
      }
      resolve({ copied: true });
    });
    child.stdin && child.stdin.end(cleaned);
  });
}

// Enable terminal bracketed paste at startup and disable on exit
function enableBracketedPaste() {
  try { process.stdout.write('\x1b[?2004h'); } catch {}
}
function disableBracketedPaste() {
  try { process.stdout.write('\x1b[?2004l'); } catch {}
}

// Add an enhanced paste mode function
globalThis.enhancedPasteMode = async () => {
  return new Promise((resolve) => {
    console.log(chalk.blue('Paste Mode: Paste your multiline text.'));
    console.log(chalk.blue('Finish with "\\end" or "/end" on a new line, or rely on auto-detect.'));
    console.log(chalk.gray('Tips: Windows Ctrl+Z then Enter may also end input; Ctrl+C cancels.'));
    
    // Save current stdin settings
    const originalRawMode = process.stdin.isRaw;
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
    
    let buffer = '';
    
    let bracketPasting = false;
    const dataHandler = (chunk) => {
      const data = chunk.toString('utf8');

      // Detect terminal bracketed paste sequences
      if (data.includes('\u001b[200~')) {
        bracketPasting = true;
        // Strip the start marker and keep the rest
        buffer += data.replace(/\u001b\[200~/g, '');
        return;
      }
      if (bracketPasting) {
        // Check for end marker
        if (data.includes('\u001b[201~')) {
          const beforeEnd = data.replace(/\u001b\[201~/g, '');
          buffer += beforeEnd;
          bracketPasting = false;
          cleanup();
          resolve(buffer);
          return;
        }
        buffer += data;
        return;
      }

      // Cross-platform end markers: explicit \end or /end line, Windows EOT (Ctrl+Z), or closing code fence
      if (data.trim() === '\\end' || data.trim() === '/end' || data.includes('\\end\n') || data.includes('\\end\r\n') || /(?:^|\r?\n)\/end(?:\r?\n|$)/.test(data) || data.includes('\x1A')) {
        let cleanedBuffer = buffer;
        if (data.trim() === '\\end' || data.trim() === '/end') {
          cleanedBuffer = buffer.replace(/\\end$/, '');
          cleanedBuffer = cleanedBuffer.replace(/\n\/end$/, '');
        } else if (data.includes('\\end\n')) {
          cleanedBuffer = buffer.replace(/\\end\n/, '');
        } else if (data.includes('\\end\r\n')) {
          cleanedBuffer = buffer.replace(/\\end\r\n/, '');
        } else if (/(?:^|\r?\n)\/end(?:\r?\n|$)/.test(data)) {
          cleanedBuffer = buffer.replace(/\n\/end\r?\n?$/, '\n');
        } else if (data.includes('\x1A')) {
          // Strip Windows EOT if present
          cleanedBuffer = buffer.replace(/\x1A/g, '');
        }
        cleanup();
        resolve(cleanedBuffer);
        return;
      }

      // If user pastes/enters a closing code fence and we already have content, treat as done
      if (/^\s*```\s*$/.test(data) && buffer.length > 0) {
        cleanup();
        resolve(buffer);
        return;
      }

      buffer += data;
    };
    
    // Set up the handlers
    process.stdin.on('data', dataHandler);
    
    // Add a timeout to avoid hanging
    let timeoutId = setTimeout(() => {
      console.log(chalk.yellow('Paste mode timed out after 2 minutes'));
      cleanup();
      resolve(buffer || '');
    }, 120000);
    
    // Create a SIGINT handler for Ctrl+C
    const sigintHandler = () => {
      console.log(chalk.yellow('Paste mode canceled'));
      cleanup();
      resolve('');
    };
    process.once('SIGINT', sigintHandler);
    
    // Create cleanup function
    const cleanup = () => {
      process.stdin.removeListener('data', dataHandler);
      process.removeListener('SIGINT', sigintHandler);
      clearTimeout(timeoutId);
      
      // Restore stdin settings
      if (process.stdin.setRawMode && originalRawMode !== undefined) {
        process.stdin.setRawMode(originalRawMode);
      }
    };
  });
};

// Export the review functions to make them accessible without importing
globalThis.isReviewRequest = (question) => {
  return question.toLowerCase().startsWith('\\review') || 
         question.toLowerCase() === '\\r' || 
         question.toLowerCase().startsWith('\\r ');
};

// Export paste mode detection function
globalThis.isPasteMode = (input) => {
  return input.toLowerCase() === '\\p' || 
         input.toLowerCase() === '\\paste';
};

// Add automatic multiline paste detection
globalThis.isMultilinePaste = (input) => {
  if (!input) return false;
  // Heuristics: presence of multiple lines or large payloads indicate paste
  const hasNewline = /\r?\n/.test(input);
  if (!hasNewline) return false;

  const lines = input.split(/\r?\n/);
  const nonEmptyLines = lines.filter(l => l.trim().length > 0).length;
  const looksLikeCodeFence = /```/.test(input);
  const longText = input.length > 200; // safety threshold

  return nonEmptyLines > 1 || looksLikeCodeFence || longText;
};

// Add a message at the end of the startup process
const originalExit = process.exit;
process.exit = (code) => {
  if (code === 0) {
    console.log(chalk.blue("\nNew command: ") + chalk.green("\\review [directory]") + chalk.blue(" or ") + chalk.green("\\r [directory]") + chalk.blue(" - Analyze code directories with parallel processing"));
  }
  originalExit(code);
};

// Also ensure bracketed paste disabled on exit
process.on('exit', disableBracketedPaste);
process.on('SIGINT', () => { disableBracketedPaste(); });

// DirectoryAnalyzer instance will be created after class definition

// Application configuration
let config;
const DEFAULT_CONFIG_PATH = path.join(installDir, 'config.json');
let aiIgnorePatterns = [];
// Terminal mode state
let terminalModeActive = false;
let currentWorkingDirectory = process.cwd();
// Format cwd for prompt display
function formatCwdForPrompt() {
  try {
    const home = os.homedir();
    let p = currentWorkingDirectory || process.cwd();
    if (p.startsWith(home)) p = '~' + p.slice(home.length);
    return p;
  } catch {
    return currentWorkingDirectory || process.cwd();
  }
}

// Change working directory helper
function changeWorkingDirectory(targetPath, createIfMissing = false) {
  try {
    if (!targetPath || !targetPath.trim()) throw new Error('No path provided');
    let p = targetPath.trim();
    if (p === '~') p = os.homedir();
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
    if (!path.isAbsolute(p)) p = path.resolve(currentWorkingDirectory, p);
    if (!fs.existsSync(p)) {
      if (createIfMissing) {
        fs.mkdirSync(p, { recursive: true });
      } else {
        throw new Error(`Directory does not exist: ${p}`);
      }
    }
    if (!fs.statSync(p).isDirectory()) throw new Error(`Not a directory: ${p}`);
    currentWorkingDirectory = p;
    console.log(chalk.green(`Changed directory to: ${formatCwdForPrompt()}`));
    return true;
  } catch (e) {
    console.log(chalk.red(e.message));
    return false;
  }
}

// Simple directory navigation mode using inquirer
async function startNavigationMode() {
  let browsing = true;
  let cursor = currentWorkingDirectory;
  while (browsing) {
    let entries = [];
    try {
      entries = fs.readdirSync(cursor, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort((a,b)=>a.localeCompare(b));
    } catch {
      entries = [];
    }
    const choices = [];
    choices.push({ name: chalk.green('Set here and exit'), value: '__set' });
    choices.push({ name: chalk.yellow('Up one level (..)'), value: '__up' });
    entries.forEach(name => choices.push({ name, value: name }));
    choices.push(new inquirer.Separator());
    choices.push({ name: 'Quit navigation', value: '__quit' });

    const ans = await inquirer.prompt([
      {
        type: 'list',
        name: 'nav',
        message: `Navigate: ${cursor}`,
        pageSize: 20,
        choices
      }
    ]);

    if (ans.nav === '__set') {
      if (changeWorkingDirectory(cursor, false)) return true;
      return false;
    } else if (ans.nav === '__up') {
      const up = path.dirname(cursor);
      cursor = up;
    } else if (ans.nav === '__quit') {
      return false;
    } else {
      cursor = path.join(cursor, ans.nav);
    }
  }
  return false;
}

// Function to check if a question is a directory review request
function isReviewRequest(question) {
  // Check for explicit review command
  if (question.toLowerCase().startsWith('\\review') || question.toLowerCase() === '\\r' || question.toLowerCase().startsWith('\\r ')) {
    return true;
  }
  
  // Check for review patterns in natural language
  const reviewPatterns = [
    /review\s+(the\s+)?(code|application|app|project|directory|repo)\s+in\s+['".]/, 
    /analyze\s+(the\s+)?(code|application|app|project|directory|repo)\s+in\s+['".]/, 
    /review\s+(the\s+)?(code|application|app|project|directory|repo)\s+at\s+['".]/, 
    /look\s+at\s+(the\s+)?(code|application|app|project|directory|repo)\s+in\s+['".]/, 
    /examine\s+(the\s+)?(code|application|app|project|directory|repo)\s+in\s+['".]/, 
    /check\s+(the\s+)?(code|application|app|project|directory|repo)\s+in\s+['".]/
  ];
  
  return reviewPatterns.some(pattern => pattern.test(question.toLowerCase()));
}

// Function to extract directory path from a review request
function extractDirectoryPath(question) {
  if (question.toLowerCase().startsWith('\\review') || question.toLowerCase() === '\\r' || question.toLowerCase().startsWith('\\r ')) {
    const parts = question.split(' ');
    parts.shift(); // Remove command
    return parts.join(' ').trim() || '.';
  }
  
  // Extract path from natural language
  const pathMatches = question.match(/(in|at)\s+['"]?([^'"]+)['"]?/);
  if (pathMatches && pathMatches[2]) {
    return pathMatches[2].trim();
  }
  
  return '.'; // Default to current directory
}

// Function to handle directory review requests
async function handleReviewRequest(question) {
  const dirPath = extractDirectoryPath(question);
  const results = await reviewDirectory(dirPath);
  
  if (results) {
    // Force using powerful model for analysis
    let prevAgenticMode = false;
    if (config && config.agentic) {
      prevAgenticMode = config.agentic.autoDetect;
      config.agentic.autoDetect = true;
    }
    
    // Get response from AI
    const response = await getCompletion();
    
    // Reset to config default
    if (config && config.agentic) {
      config.agentic.autoDetect = prevAgenticMode;
    }
    
    // Show the response
    displayAssistantResponse(response);
    
    // Add to history
    conversationHistory.push({
      role: 'assistant',
      content: response
    });
    
    return true;
  }
  
  return false;
}

// Function to review a directory
async function reviewDirectory(dirPath = '.', addToHistory = true) {
  // Resolve the directory path relative to current working directory
  const resolvedPath = path.resolve(currentWorkingDirectory, dirPath);
  
  // No directory restrictions - always allow reviewing from current working directory
  
  // Show progress spinner
  const spinner = ora({
    text: chalk.blue(`Analyzing directory ${resolvedPath}...`),
    spinner: 'dots'
  }).start();
  
  try {
    // Setup progress handler
    directoryAnalyzer.on('progress', (progress) => {
      spinner.text = chalk.blue(`Analyzing files (${progress.processed}/${progress.total}, ${progress.percentage}%)`);
    });
    
    // Run analysis
    const results = await directoryAnalyzer.analyzeDirectory(resolvedPath);
    
    // Update spinner when complete
    spinner.succeed(chalk.green(`Directory analysis complete! Analyzed ${results.analyzedFiles} files.`));
    
    // Only add to conversation history if required
    if (addToHistory) {
      // Add directory structure to conversation
      conversationHistory.push({
        role: 'system',
        content: `Directory analysis results for ${resolvedPath}:
1. Total files analyzed: ${results.analyzedFiles}
2. Directory structure: ${results.summary}
3. ${Object.keys(results.fileContents).length} file contents have been captured and are available for reference.
4. Errors encountered: ${results.errors.length}

Please provide a comprehensive review of this codebase based on the files analyzed.`
      });
      
      // Group files by type for better context management
      const fileGroups = {};
      Object.entries(results.fileContents).forEach(([filePath, content]) => {
        const ext = path.extname(filePath).toLowerCase();
        const category = ext.replace('.', '') || 'other';
        fileGroups[category] = fileGroups[category] || [];
        fileGroups[category].push({path: filePath, content: content});
      });
      
      // Add file contents by category
      Object.entries(fileGroups).forEach(([category, files]) => {
        if (files.length > 0) {
          // Create a condensed representation of this file type
          const fileContents = files.map(f => 
            `File: ${f.path}\n${f.content.substring(0, Math.min(f.content.length, 2000))}\n${f.content.length > 2000 ? '... (truncated)' : ''}`
          ).join('\n\n---\n\n');
          
          conversationHistory.push({
            role: 'system',
            content: `${category.toUpperCase()} FILES (${files.length}):\n${fileContents}`
          });
        }
      });
      
      // Add a user message to trigger AI response
      conversationHistory.push({
        role: 'user',
        content: `Please review the codebase in ${resolvedPath} and provide a comprehensive analysis.`
      });
    }
    
    return results;
  } catch (error) {
    spinner.fail(chalk.red(`Error analyzing directory: ${error.message}`));
    return null;
  }
}

// Load .aiignore file and parse patterns
function loadAiIgnorePatterns(currentDir = null) {
  // Use the current working directory if no directory is specified
  const dirToUse = currentDir || currentWorkingDirectory;
  const aiIgnorePath = path.join(dirToUse, '.aiignore');
  
  // Reset patterns
  aiIgnorePatterns = [];
  
  // Default patterns to always ignore
  const defaultPatterns = [
    '.env',
    'node_modules/',
    '.git/',
    '*.env',
    '.env.*',
    '*.pem',
    '*.key',
    'secrets.json',
    'credentials.json'
  ];
  
  // Add default patterns
  aiIgnorePatterns.push(...defaultPatterns);
  
  // If .aiignore exists, load custom patterns
  if (fs.existsSync(aiIgnorePath)) {
    try {
      const content = fs.readFileSync(aiIgnorePath, 'utf8');
      const customPatterns = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      
      aiIgnorePatterns.push(...customPatterns);
    } catch (error) {
      console.error(`Error loading .aiignore: ${error.message}`);
    }
  }
  
  return aiIgnorePatterns;
}

// Check if a path matches any ignore pattern
function isPathIgnored(filePath, patterns) {
  // Get relative path for matching
  const currentDir = __dirname;
  let relativePath = path.relative(currentDir, filePath);
  
  // On Windows, convert backslashes to forward slashes for consistent matching
  relativePath = relativePath.replace(/\\/g, '/');
  
  // Check if the path exactly matches or is within an ignored directory
  return patterns.some(pattern => {
    // Direct match
    if (relativePath === pattern) return true;
    
    // Directory pattern (ends with /)
    if (pattern.endsWith('/') && relativePath.startsWith(pattern)) return true;
    
    // Glob pattern matching
    if (pattern.includes('*')) {
      const regexPattern = pattern
        .replace(/\./g, '\\.') // Escape dots
        .replace(/\*/g, '.*'); // Convert * to regex equivalent
      
      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(relativePath);
    }
    
    return false;
  });
}

// Create a new .aiignore file with default patterns
function createDefaultAiIgnore(dirPath) {
  const aiIgnorePath = path.join(dirPath, '.aiignore');
  
  // Default patterns to always ignore
  const defaultPatterns = [
    '# Default patterns for .aiignore',
    '# Files and directories listed here will not be accessible to the AI',
    '.env',
    'node_modules/',
    '.git/',
    '*.env',
    '.env.*',
    '*.pem',
    '*.key',
    'secrets.json',
    'credentials.json',
    '',
    '# Add your custom patterns below'
  ];
  
  try {
    fs.writeFileSync(aiIgnorePath, defaultPatterns.join('\n'));
    return true;
  } catch (error) {
    console.error(`Error creating .aiignore: ${error.message}`);
    return false;
  }
}

// Add a pattern to .aiignore file
function addToAiIgnore(dirPath, pattern) {
  const aiIgnorePath = path.join(dirPath, '.aiignore');
  try {
    let content = '';
    if (fs.existsSync(aiIgnorePath)) {
      content = fs.readFileSync(aiIgnorePath, 'utf8');
      if (!content.endsWith('\n')) content += '\n';
    } else {
      // Create the file if it doesn't exist
      createDefaultAiIgnore(dirPath);
      content = fs.readFileSync(aiIgnorePath, 'utf8');
    }
    
    // Add the pattern if it doesn't already exist
    const lines = content.split('\n');
    if (!lines.includes(pattern)) {
      content += pattern + '\n';
      fs.writeFileSync(aiIgnorePath, content);
      return true;
    }
    return false; // Pattern already exists
  } catch (error) {
    console.error(`Error adding to .aiignore: ${error.message}`);
    return false;
  }
}

// Note: Using loadAiIgnorePatterns function defined at the top of the file
// Note: isPathIgnored function is defined elsewhere in the file
config = {
  currentProvider: 'anthropic', // Default provider
  models: {
    openai: 'gpt-4o',
    anthropic: 'claude-3-7-sonnet-20250219',
    google: 'gemini-2.0-flash',
    openrouter: 'openrouter/deepseek/deepseek-r1:free'
  },
  lightModels: {
    openai: 'gpt-3.5-turbo',
    anthropic: 'claude-3-haiku-20240307',
    google: 'gemini-2.0-flash-lite',
    openrouter: 'openrouter/deepseek/deepseek-chat:free'
  },
  maxContextMessages: 100, // Default context window size
  agentMode: {
    enabled: false,
    routingThreshold: 0.7 // Confidence threshold for routing to powerful model
  },
  reasoningMode: {
    enabled: false,
    iterations: 3, // Default number of self-improvement iterations
    showIntermediate: false // Whether to show intermediate reasoning steps
  },
  agent: {
    enabled: true,
    useVirtualEnvironment: false,
    autoApproveExec: true,
    autoApproveFsSafe: true,
    allowedDirectories: [__dirname], // Default to application directory
    disallowedCommands: [
      'rm -rf', 'sudo', 'chmod', 'chown',
      'mv /', 'cp /', 'find /', 
      '> /dev', 'curl | bash', 'wget | bash'
    ]
  },
  codingMode: {
    enabled: false,
    maxContextMessages: 500, // Expanded context for coding mode
    projectContextFile: 'ai.md', // Project-specific knowledge and context
    currentContextFile: 'current.md', // Current conversation context
    lastCompacted: null // Timestamp of last compaction
  },
  agentic: {
    enabled: false,
    usePowerfulConductor: false, // Whether to use a powerful model as conductor
    maxConcurrentAgents: 5, // Maximum number of concurrent agent tasks
    maxActionsPerAgent: 20, // Maximum actions per agent before asking permission
    defaultTimeout: 300000, // Default timeout for agent tasks (5 minutes)
    taskHistoryFile: 'task-history.json', // File to store task execution history
    taskTypes: [
      'research',   // Web research tasks
      'coding',     // Code generation and modification
      'analysis',   // Data or code analysis
      'filesystem', // File operations
      'automation'  // Local automation tasks
    ],
    historyPath: __dirname // In your config initialization or wherever you set up default config values
  },
  // Automatic, non-destructive helpers that run before AI
  autoActions: {
    localSearchBeforeAI: true, // Try to answer by scanning local project first
    maxGrepHits: 80,           // Cap total grep results
    maxSnippetsPerFile: 2,     // Cap snippets per file in output
    snippetContext: 2          // Lines of context around each grep hit
  }
};

// Message history for context
let messageHistory = [];

// User input history for up/down navigation
let inputHistory = [];
let inputHistoryIndex = -1;
// One-time notice for deprecated forward-slash commands
let warnedAboutSlash = false;

// Agentic mode state
let taskManager = null;
let activeTaskId = null;

// Simple argv-style tokenizer that respects quotes
function tokenizeArgs(input) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

// Helpers for file ops in currentWorkingDirectory
function resolveFromCwd(p) {
  if (!p || p === '.') return currentWorkingDirectory;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) ? p : path.resolve(currentWorkingDirectory, p);
}

function safeReadTextFile(filePath, maxBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    const buf = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' });
    return buf.slice(0, maxBytes) + `\n... (truncated ${stat.size - maxBytes} bytes)`;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function headTail(filePath, count = 10, mode = 'head') {
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split(/\r?\n/);
  const out = (mode === 'head') ? lines.slice(0, count) : lines.slice(Math.max(0, lines.length - count));
  return out.join('\n');
}

function formatPathForPrint(p) {
  try { const home = os.homedir(); return p.startsWith(home) ? '~' + p.slice(home.length) : p; } catch { return p; }
}

// Detect if current directory looks like a project
function isLikelyProjectDir(dir = currentWorkingDirectory) {
  try {
    const entries = fs.readdirSync(dir).map(n => n.toLowerCase());
    const hasMarkers = [
      'package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml',
      'go.mod', 'readme.md', 'readme', 'setup.py', 'index.js', 'src'
    ].some(m => entries.includes(m) || entries.includes(m.toLowerCase()));
    return hasMarkers;
  } catch {
    return false;
  }
}

// Extract salient keywords from a natural-language question
function extractQueryKeywords(question) {
  const stop = new Set(['what','can','you','tell','me','about','the','in','this','app','project','repo','application','feature','of','is','a','an','to','and','on','for','with','how']);
  return (question.toLowerCase().match(/[a-z0-9_\-.]+/g) || [])
    .filter(w => !stop.has(w) && w.length >= 2)
    .slice(0, 6);
}

// Determine likely entrypoint/doc files to inspect
function guessEntrypointFiles(dir = currentWorkingDirectory) {
  const out = new Set();
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main) out.add(path.resolve(dir, pkg.main));
      out.add(path.resolve(dir, 'index.js'));
      out.add(pkg.bin && typeof pkg.bin === 'string' ? path.resolve(dir, pkg.bin) : null);
      if (pkg.bin && typeof pkg.bin === 'object') {
        Object.values(pkg.bin).forEach(p => out.add(path.resolve(dir, p)));
      }
    }
  } catch {}
  const candidates = ['index.js','main.js','src/index.js','app.js','cli.js','README.md','HELP.txt','docs/README.md'];
  for (const c of candidates) {
    const p = path.resolve(dir, c);
    if (fs.existsSync(p)) out.add(p);
  }
  return [...out].filter(Boolean);
}

// Run a safe recursive grep for keywords with exclusions
async function grepProjectKeywords(keywords, dir = currentWorkingDirectory) {
  if (!keywords || keywords.length === 0) return [];
  const pattern = keywords.map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
  const excludeDirs = ['node_modules','.git','dist','build','.next','.cache'];
  const excludeArgs = excludeDirs.map(d => `--exclude-dir=${d}`).join(' ');
  const cmd = `grep -Rin ${excludeArgs} -E "${pattern}" . || true`;
  return new Promise((resolve) => {
    exec(cmd, { cwd: dir, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      const lines = (stdout || '').split('\n').filter(Boolean);
      resolve(lines.map(line => {
        const m = line.match(/^(.+?):(\d+):(.*)$/);
        if (!m) return null;
        const fp = path.resolve(dir, m[1]);
        return { file: fp, line: parseInt(m[2], 10), text: m[3] };
      }).filter(Boolean));
    });
  });
}

// Build small snippets around matches
function buildSnippets(matches, opts = {}) {
  const maxPerFile = opts.maxPerFile || config.autoActions.maxSnippetsPerFile;
  const ctx = Math.max(0, opts.context || config.autoActions.snippetContext);
  const byFile = new Map();
  for (const m of matches) {
    if (!fs.existsSync(m.file)) continue;
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    const arr = byFile.get(m.file);
    if (arr.length >= maxPerFile) continue;
    try {
      const data = fs.readFileSync(m.file, 'utf8');
      const lines = data.split(/\r?\n/);
      const start = Math.max(0, m.line - 1 - ctx);
      const end = Math.min(lines.length, m.line - 1 + ctx + 1);
      const snippet = lines.slice(start, end).join('\n');
      arr.push({ line: m.line, snippet });
    } catch {}
  }
  return byFile;
}

// Attempt a local, non-destructive project scan to answer the question
async function tryLocalProjectAnswer(question, opts = {}) {
  try {
    if (!config.autoActions?.localSearchBeforeAI) return null;
    if (!isLikelyProjectDir(currentWorkingDirectory)) return null;

    // Only trigger for explicit project-scoped questions
    const q = (question || '').toLowerCase();
    const explicitScope = /(in\s+(this|the)\s+(app|project|repo|codebase|directory|folder))|\bthis\s+(app|project|repo|codebase)\b|\breview\b/.test(q);
    if (!explicitScope) return null;

    const keywords = extractQueryKeywords(question);
    if (keywords.length === 0) return null;

    const silent = !!opts.silent;
    const spinner = silent ? null : ora({ text: chalk.blue(`Scanning project for: ${keywords.join(', ')}`), spinner: 'dots' }).start();

    // Always gather docs/entrypoints
    const entryFiles = guessEntrypointFiles();

    // Grep for keywords
    let matches = await grepProjectKeywords(keywords);
    if (matches.length > config.autoActions.maxGrepHits) {
      matches = matches.slice(0, config.autoActions.maxGrepHits);
    }

    const snippetsByFile = buildSnippets(matches);

    // Build answer
    const lines = [];
    lines.push(`Local project scan for: ${keywords.join(', ')}`);
    lines.push(`Working directory: ${formatCwdForPrompt()}`);
    if (entryFiles.length) {
      lines.push(`Likely entry/docs: ${entryFiles.map(f => formatPathForPrint(path.relative(currentWorkingDirectory, f))).join(', ')}`);
    }

    if (snippetsByFile.size === 0) {
      if (spinner) spinner.succeed(chalk.green('Scan complete (no direct references found).'));
      lines.push('No direct references found via grep. Consider broader review (\\review .) or ask a follow-up.');
      return lines.join('\n');
    }

    if (spinner) spinner.succeed(chalk.green(`Scan complete. Found ${matches.length} references in ${snippetsByFile.size} files.`));

    // Format snippets
    for (const [file, arr] of snippetsByFile.entries()) {
      const rel = formatPathForPrint(path.relative(currentWorkingDirectory, file));
      lines.push(`\nFile: ${rel}`);
      arr.forEach(s => {
        lines.push(`- Line ${s.line}:\n${s.snippet}`);
      });
    }

    // Closing tip
    lines.push('\nTip: Use \\review . for a comprehensive, parallel file analysis.');
    return lines.join('\n');
  } catch (e) {
    // Fail open to normal AI flow
    return null;
  }
}

// Check if the input should use agentic mode based on complexity
async function shouldUseAgentic(question) {
  // Check complexity indicators
  const complexityIndicators = [
    'multiple', 'steps', 'research', 'analyze', 'summarize',
    'compare', 'implement', 'design', 'find', 'explain'
  ];
  
  const hasComplexity = complexityIndicators.some(indicator => 
    question.toLowerCase().includes(indicator)
  );
  
  // Check length as another heuristic
  const isLongQuery = question.length > 100;
  
  return hasComplexity || isLongQuery;
}

// Agentic task manager class
class AgentTaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.agents = new Map();
    this.taskHistory = [];
    this.loadTaskHistory();
  }

  // Classify task to determine complexity and parallelization needs
  async classifyTask(taskDescription) {
    // Simple classification based on keywords
    const complexityIndicators = {
      research: ['research', 'find information', 'look up', 'search for'],
      code: ['code', 'program', 'implement', 'develop', 'function', 'class'],
      analyze: ['analyze', 'compare', 'evaluate', 'assess', 'review'],
      write: ['write', 'draft', 'compose', 'create content'],
      summarize: ['summarize', 'condense', 'overview', 'recap']
    };
    
    // Check for matches in complexity indicators
    let matchedTypes = [];
    for (const [type, keywords] of Object.entries(complexityIndicators)) {
      if (keywords.some(keyword => taskDescription.toLowerCase().includes(keyword))) {
        matchedTypes.push(type);
      }
    }
    
    // Determine complexity level
    let type = 'simple_question';
    if (matchedTypes.length >= 3) {
      type = 'complex_multi_domain';
    } else if (matchedTypes.length > 0) {
      type = matchedTypes[0] + '_task';
    } else if (taskDescription.length > 150) {
      type = 'detailed_request';
    }
    
    return {
      type,
      complexity: matchedTypes.length > 0 ? 'complex' : 'simple',
      domains: matchedTypes,
      isParallelizable: matchedTypes.length > 1
    };
  }
  
  // Load previous task history from file
  loadTaskHistory() {
    // Set a default path if not provided in config
    const baseDir = config.agentic?.historyPath || __dirname;
    const fileName = config.agentic?.taskHistoryFile || 'task-history.json';
    const taskHistoryPath = path.join(baseDir, fileName);
    
    try {
      if (fs.existsSync(taskHistoryPath)) {
        const data = fs.readFileSync(taskHistoryPath, 'utf8');
        this.taskHistory = JSON.parse(data);
        console.log(chalk.green(`✓ Loaded task history from ${taskHistoryPath}`));
      } else {
        this.taskHistory = [];
        // Create an empty history file
        fs.writeFileSync(taskHistoryPath, JSON.stringify([], null, 2));
        console.log(chalk.green(`✓ Created new task history at ${taskHistoryPath}`));
      }
    } catch (error) {
      console.error(chalk.red(`Error loading task history: ${error.message}`));
      this.taskHistory = [];
    }
  }
  
  // Save task history to file (use same base as load)
  saveTaskHistory() {
    const baseDir = config.agentic?.historyPath || __dirname;
    const fileName = config.agentic?.taskHistoryFile || 'task-history.json';
    const taskHistoryPath = path.join(baseDir, fileName);
    try {
      fs.writeFileSync(taskHistoryPath, JSON.stringify(this.taskHistory, null, 2));
    } catch (error) {
      console.error(`Error saving task history: ${error.message}`);
    }
  }
  
  // Create a new task with a conductor
  async createTask(taskDescription, usePowerfulConductor = false) {
    const taskId = uuidv4();
    const timestamp = Date.now();
    
    // Create task object
    const task = {
      id: taskId,
      description: taskDescription,
      status: 'planning',
      created: timestamp,
      updated: timestamp,
      completed: null,
      usePowerfulConductor,
      plan: null,
      agents: [],
      results: [],
      error: null
    };
    
    // Add to tasks map and history
    this.tasks.set(taskId, task);
    this.taskHistory.push({
      id: taskId,
      description: taskDescription,
      created: timestamp,
      completed: null,
      status: 'created'
    });
    this.saveTaskHistory();
    
    // Create the conductor agent
    await this.createConductor(taskId, usePowerfulConductor);
    
    return taskId;
  }
  
  // Create the conductor agent for task planning and orchestration
  async createConductor(taskId, usePowerfulModel = false) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    
    // Determine which AI model to use for the conductor
    const provider = config.currentProvider;
    const model = usePowerfulModel ? 
      config.models[provider] : 
      config.lightModels[provider];
    
    // Create conductor
    const conductor = {
      id: `${taskId}-conductor`,
      taskId,
      role: 'conductor',
      provider,
      model,
      status: 'active',
      actionsPerformed: 0,
      created: Date.now(),
      updated: Date.now(),
      results: []
    };
    
    // Add to agents map
    this.agents.set(conductor.id, conductor);
    
    // Start planning process
    this.planTask(taskId);
    
    return conductor;
  }
  
  // Plan the task using the conductor
  async planTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    
    // Classify task for simple processing path
    const singleAgentTasks = ['simple_question', 'basic_lookup', 'single_calculation'];
    const taskClassification = await this.classifyTask(task.description);

    if (singleAgentTasks.some(type => taskClassification.type === type)) {
      // Skip complex planning for simple tasks
      const simplePlan = {
        analysis: "Simple task that can be handled by a single agent",
        agentCount: 1,
        agents: [{
          role: "generalist",
          type: "comprehensive",
          goal: task.description,
          actions: [task.description],
          requiresPowerfulModel: false
        }],
        workflow: "Direct execution",
        estimatedSteps: 1,
        estimatedTimeMinutes: 1
      };
      
      // Update task with the plan
      task.plan = simplePlan;
      task.status = 'planned';
      task.updated = Date.now();
      
      // Emit task planned event
      this.emit('task-planned', task);
      
      // Start execution immediately for simple tasks
      await this.executeTask(task.id);
      
      return simplePlan;
    }
    
    // Update task status
    task.status = 'planning';
    task.updated = Date.now();
    
    // Find the conductor for this task
    const conductorId = `${taskId}-conductor`;
    const conductor = this.agents.get(conductorId);
    
    if (!conductor) {
      task.status = 'error';
      task.error = 'Conductor agent not found';
      this.emit('task-error', task);
      return;
    }
    
    // Update conductor
    conductor.status = 'planning';
    conductor.updated = Date.now();
    conductor.actionsPerformed++;
    
    try {
      // Create planning prompt
      const planningPrompt = `You are an AI task conductor responsible for planning and orchestrating a complex task. Your job is to analyze the task, determine the best approach, and create a detailed execution plan.
      
      ## Task Description
      ${task.description}
      
      ## Available Agent Types
      ${config.agentic.taskTypes.join(', ')}
      
      ## Constraints
      - Maximum number of concurrent agents: ${config.agentic.maxConcurrentAgents}
      - Each agent can perform up to ${config.agentic.maxActionsPerAgent} actions before requiring permission
      
      ## Your Task
      1. Analyze the user's request carefully
      2. Determine if this can be done with a single agent or requires multiple specialized agents
      3. Create a detailed execution plan with the following format:
      
      {
        "analysis": "Your analysis of the task, considering complexity, required tools, potential challenges",
        "agentCount": <number of agents needed (max ${config.agentic.maxConcurrentAgents})>,
        "agents": [
          {
            "role": "Specific role for this agent (e.g., 'researcher', 'coder', 'analyzer')",
            "type": "One of the available agent types listed above",
            "goal": "Specific goal for this agent",
            "actions": ["Action 1", "Action 2", ...],
            "requiresPowerfulModel": true/false
          },
          ...
        ],
        "workflow": "How the agents will coordinate and in what sequence",
        "estimatedSteps": <estimated number of steps to complete the task>,
        "estimatedTimeMinutes": <estimated time in minutes>
      }
      
      Only respond with the JSON object, no preamble or additional text.`;
      
      // Get AI response based on the conductor's provider/model
      let planResponse;
      
      switch (conductor.provider) {
        case 'openai':
          if (!openai) throw new Error('OpenAI API key not configured');
          
          const openaiResponse = await openai.chat.completions.create({
            model: conductor.model,
            messages: [
              { role: 'system', content: 'You are an expert AI task planner and orchestrator.' },
              { role: 'user', content: planningPrompt }
            ],
            ...(!(conductor.model && typeof conductor.model === 'string' && conductor.model.startsWith('gpt-5')) ? { temperature: 0.7 } : {}),
          });
          
          planResponse = openaiResponse.choices[0].message.content;
          break;
          
        case 'anthropic':
          if (!anthropic) throw new Error('Anthropic API key not configured');
          
          const anthropicResponse = await anthropic.messages.create({
            model: conductor.model,
            system: 'You are an expert at summarizing coding conversations, retaining only the essential information needed for future context.',
            messages: [
              { role: 'user', content: summaryPrompt }
            ],
            max_tokens: 4000,
            temperature: 0.3,
          });
          
          planResponse = anthropicResponse.content[0].text;
          break;
          
        case 'google':
          if (!genAI) throw new Error('Google AI API key not configured');
          
          const systemPrompt = 'You are an expert AI task planner and orchestrator.';
          const googleMessages = [systemPrompt, planningPrompt].join('\n\n');
          const googleModel = genAI.getGenerativeModel({ model: conductor.model });
          const googleResponse = await googleModel.generateContent(googleMessages);
          
          planResponse = googleResponse.response.text();
          break;
          
        case 'openrouter':
          if (!openRouter) throw new Error('OpenRouter API key not configured');
          
          const openRouterResponse = await openRouter.chat.completions.create({
            model: conductor.model,
            messages: [
              { role: 'system', content: 'You are an expert AI task planner and orchestrator.' },
              { role: 'user', content: planningPrompt }
            ],
            temperature: 0.7,
          });
          
          planResponse = openRouterResponse.choices[0].message.content;
          break;
          
        default:
          throw new Error(`Unknown provider: ${conductor.provider}`);
      }
      
      // Parse the plan
      let plan;
      try {
        // Extract JSON from response (accounting for possible markdown code blocks)
        const jsonMatch = planResponse.match(/```(?:json)?\s*({[\s\S]*?})\s*```/) || 
                         [null, planResponse.trim()];
        
        const jsonStr = jsonMatch[1].trim();
        plan = JSON.parse(jsonStr);
        
        // Validate plan has required fields
        if (!plan.agents || !Array.isArray(plan.agents) || !plan.workflow) {
          throw new Error('Invalid plan format');
        }
        
        // Update task with plan
        task.plan = plan;
        task.status = 'planned';
        
        // Limit agents to max allowed
        if (plan.agents.length > config.agentic.maxConcurrentAgents) {
          plan.agents = plan.agents.slice(0, config.agentic.maxConcurrentAgents);
          plan.agentCount = config.agentic.maxConcurrentAgents;
        }
        
        // Add plan to conductor results
        conductor.results.push({
          type: 'plan',
          content: plan,
          timestamp: Date.now()
        });
        
        // Emit plan created event
        this.emit('task-planned', task);
        
        // Move to execution phase
        this.executeTask(taskId);
        
      } catch (error) {
        console.error(`Error parsing plan: ${error.message}`);
        // Store the raw response for debugging
        conductor.results.push({
          type: 'error',
          content: planResponse,
          timestamp: Date.now(),
          error: error.message
        });
        
        // Retry planning with a more structured approach
        await this.retryPlanning(taskId);
      }
      
    } catch (error) {
      console.error(`Error planning task: ${error.message}`);
      task.status = 'error';
      task.error = `Error planning task: ${error.message}`;
      conductor.status = 'error';
      this.emit('task-error', task);
    }
  }
  
  // Retry planning with more structure
  async retryPlanning(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    
    const conductorId = `${taskId}-conductor`;
    const conductor = this.agents.get(conductorId);
    
    if (!conductor) return;
    
    // Update states
    conductor.status = 'replanning';
    conductor.updated = Date.now();
    conductor.actionsPerformed++;
    
    task.status = 'replanning';
    task.updated = Date.now();
    
    try {
      // Create a more structured planning prompt with specific questions
      const replanningPrompt = `I need you to help plan a task but with a more structured approach.
      
      ## Task Description
      ${task.description}
      
      ## Available Agent Types
      ${config.agentic.taskTypes.join(', ')}
      
      ## Questions to Answer (one by one)
      
      1. What is your analysis of this task? Consider complexity, required tools, and potential challenges.
      
      2. How many agents would you recommend for this task? (Maximum allowed: ${config.agentic.maxConcurrentAgents})
      
      3. For each agent, provide:
         - Role (specific title for this agent)
         - Type (must be one of: ${config.agentic.taskTypes.join(', ')})
         - Goal (specific objective for this agent)
         - Does this agent require a powerful AI model? (yes/no)
         - List of actions this agent will take (numbered list)
      
      4. Explain the workflow: How will these agents coordinate and in what sequence?
      
      5. Estimate the number of steps needed to complete the task
      
      6. Estimate the time required in minutes
      
      Answer each question clearly and separately.`;
      
      // Get AI response
      let replanResponse;
      
      switch (conductor.provider) {
        case 'openai':
          if (!openai) throw new Error('OpenAI API key not configured');
          
          const openaiResponse = await openai.chat.completions.create({
            model: conductor.model,
            messages: [
              { role: 'system', content: 'You are an expert AI task planner and orchestrator.' },
              { role: 'user', content: replanningPrompt }
            ],
            ...(!(conductor.model && typeof conductor.model === 'string' && conductor.model.startsWith('gpt-5')) ? { temperature: 0.5 } : {}),
          });
          
          replanResponse = openaiResponse.choices[0].message.content;
          break;
          
        case 'anthropic':
          if (!anthropic) throw new Error('Anthropic API key not configured');
          
          // Extract system message if present
          const anthropicSystemMsg = reasoningContext.find(msg => msg.role === 'system')?.content || '';
          
          // Create messages array without system message
          const anthropicReasoningMessages = reasoningContext
            .filter(msg => msg.role !== 'system')
            .map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            }));
          
          const anthropicResponse = await anthropic.messages.create({
            model: model,
            system: anthropicSystemMsg,
            messages: anthropicReasoningMessages,
            max_tokens: 1024,
            temperature: 0.7,
          });
          
          replanResponse = anthropicResponse.content[0].text;
          break;
          
        case 'google':
          if (!genAI) throw new Error('Google AI API key not configured');
          
          const systemPrompt = 'You are an expert AI task planner and orchestrator.';
          const googleMessages = [systemPrompt, replanningPrompt].join('\n\n');
          const googleModel = genAI.getGenerativeModel({ model: conductor.model });
          const googleResponse = await googleModel.generateContent(googleMessages);
          
          replanResponse = googleResponse.response.text();
          break;
          
        case 'openrouter':
          if (!openRouter) throw new Error('OpenRouter API key not configured');
          
          const openRouterResponse = await openRouter.chat.completions.create({
            model: conductor.model,
            messages: [
              { role: 'system', content: 'You are an expert AI task planner and orchestrator.' },
              { role: 'user', content: replanningPrompt }
            ],
            temperature: 0.5,
          });
          
          replanResponse = openRouterResponse.choices[0].message.content;
          break;
          
        default:
          throw new Error(`Unknown provider: ${conductor.provider}`);
      }
      
      // Now convert the structured response to a plan
      const convertResponsePrompt = `Convert the following structured task planning response into a valid JSON plan object with the format:

{
  "analysis": "Analysis of the task",
  "agentCount": <number>,
  "agents": [
    {
      "role": "Role name",
      "type": "One of the task types",
      "goal": "Goal description",
      "actions": ["Action 1", "Action 2", ...],
      "requiresPowerfulModel": true/false
    },
    ...
  ],
  "workflow": "Workflow description",
  "estimatedSteps": <number>,
  "estimatedTimeMinutes": <number>
}

The response to convert:
${replanResponse}

Only output valid JSON, no additional text or explanations.`;
      
      // Get conversion response
      let conversionResponse;
      
      switch (conductor.provider) {
        case 'openai':
          if (!openai) throw new Error('OpenAI API key not configured');
          
          const openaiResponse = await openai.chat.completions.create({
            model: conductor.model,
            messages: [
              { role: 'system', content: 'You convert structured text to JSON without adding any additional content.' },
              { role: 'user', content: convertResponsePrompt }
            ],
            ...(!(conductor.model && typeof conductor.model === 'string' && conductor.model.startsWith('gpt-5')) ? { temperature: 0.1 } : {}),
          });
          
          conversionResponse = openaiResponse.choices[0].message.content;
          break;
          
        case 'anthropic':
          if (!anthropic) throw new Error('Anthropic API key not configured');
          
          const anthropicResponse = await anthropic.messages.create({
            model: conductor.model,
            messages: [
              { role: 'system', content: 'You convert structured text to JSON without adding any additional content.' },
              { role: 'user', content: convertResponsePrompt }
            ],
            max_tokens: 2000,
            temperature: 0.1,
          });
          
          conversionResponse = anthropicResponse.content[0].text;
          break;
          
        case 'google':
          if (!genAI) throw new Error('Google AI API key not configured');
          
          const systemPrompt = 'You convert structured text to JSON without adding any additional content.';
          const googleMessages = [systemPrompt, convertResponsePrompt].join('\n\n');
          const googleModel = genAI.getGenerativeModel({ model: conductor.model });
          const googleResponse = await googleModel.generateContent(googleMessages);
          
          conversionResponse = googleResponse.response.text();
          break;
          
        case 'openrouter':
          if (!openRouter) throw new Error('OpenRouter API key not configured');
          
          const openRouterResponse = await openRouter.chat.completions.create({
            model: conductor.model,
            messages: [
              { role: 'system', content: 'You convert structured text to JSON without adding any additional content.' },
              { role: 'user', content: convertResponsePrompt }
            ],
            temperature: 0.1,
          });
          
          conversionResponse = openRouterResponse.choices[0].message.content;
          break;
          
        default:
          throw new Error(`Unknown provider: ${conductor.provider}`);
      }
      
      // Parse JSON
      try {
        // Extract JSON from response
        const jsonMatch = conversionResponse.match(/```(?:json)?\s*({[\s\S]*?})\s*```/) || 
                        [null, conversionResponse.trim()];
        
        const jsonStr = jsonMatch[1].trim();
        const plan = JSON.parse(jsonStr);
        
        // Validate plan has required fields
        if (!plan.agents || !Array.isArray(plan.agents) || !plan.workflow) {
          throw new Error('Invalid plan format after conversion');
        }
        
        // Update task with plan
        task.plan = plan;
        task.status = 'planned';
        
        // Limit agents to max allowed
        if (plan.agents.length > config.agentic.maxConcurrentAgents) {
          plan.agents = plan.agents.slice(0, config.agentic.maxConcurrentAgents);
          plan.agentCount = config.agentic.maxConcurrentAgents;
        }
        
        // Add plan to conductor results
        conductor.results.push({
          type: 'plan',
          content: plan,
          timestamp: Date.now()
        });
        
        // Emit plan created event
        this.emit('task-planned', task);
        
        // Move to execution phase
        this.executeTask(taskId);
        
      } catch (error) {
        console.error(`Error parsing converted plan: ${error.message}`);
        task.status = 'error';
        task.error = `Error planning task: ${error.message}`;
        conductor.status = 'error';
        this.emit('task-error', task);
      }
      
    } catch (error) {
      console.error(`Error replanning task: ${error.message}`);
      task.status = 'error';
      task.error = `Error planning task: ${error.message}`;
      conductor.status = 'error';
      this.emit('task-error', task);
    }
  }
  
  // Execute the task by launching worker agents in parallel
  async executeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.plan) return;
    
    // Update task status
    task.status = 'executing';
    task.updated = Date.now();
    
    // Find the conductor for this task
    const conductorId = `${taskId}-conductor`;
    const conductor = this.agents.get(conductorId);
    
    if (conductor) {
      conductor.status = 'orchestrating';
      conductor.updated = Date.now();
    }
    
    // Launch worker agents in parallel based on plan
    try {
      // Create agents in batches for better performance
      const batchSize = 3; // Maximum number of agents to create at once
      for (let i = 0; i < task.plan.agents.length; i += batchSize) {
        const batch = task.plan.agents.slice(i, i + batchSize);
        const agentPromises = batch.map(agentSpec => this.launchAgent(taskId, agentSpec));
        await Promise.all(agentPromises);
      }
      
      // Emit task executing event
      this.emit('task-executing', task);
      
      // The agents will run their actions in parallel in separate threads
      
    } catch (error) {
      console.error(`Error executing task: ${error.message}`);
      task.status = 'error';
      task.error = `Error executing task: ${error.message}`;
      if (conductor) conductor.status = 'error';
      this.emit('task-error', task);
    }
  }
  
  // Launch a worker agent for a specific role
  async launchAgent(taskId, agentSpec) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    
    const agentId = `${taskId}-${agentSpec.role.toLowerCase().replace(/\s+/g, '-')}`;
    
    // Determine which AI model to use
    const provider = config.currentProvider;
    const model = agentSpec.requiresPowerfulModel ? 
      config.models[provider] : 
      config.lightModels[provider];
    
    // Create agent
    const agent = {
      id: agentId,
      taskId,
      role: agentSpec.role,
      type: agentSpec.type,
      goal: agentSpec.goal,
      provider,
      model,
      status: 'starting',
      actionsPerformed: 0,
      created: Date.now(),
      updated: Date.now(),
      results: [],
      actions: agentSpec.actions || []
    };
    
    // Add to agents map
    this.agents.set(agentId, agent);
    
    // Add to task agents array
    task.agents.push(agentId);
    
    // Start agent execution
    this.runAgentActions(agentId);
    
    return agent;
  }
  
  // Run agent actions using worker threads
  async runAgentActions(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    
    const task = this.tasks.get(agent.taskId);
    if (!task) return;
    
    // Update agent status
    agent.status = 'working';
    agent.updated = Date.now();
    
    // Get the agent's actions
    const actions = agent.actions || [];
    if (actions.length === 0) {
      agent.status = 'completed';
      agent.updated = Date.now();
      this.checkTaskCompletion(agent.taskId);
      return;
    }
    
    // Determine how many actions to execute in this batch
    const remainingActionsAllowed = config.agentic.maxActionsPerAgent - agent.actionsPerformed;
    const batchSize = Math.min(remainingActionsAllowed, actions.length);
    
    if (batchSize <= 0) {
      // Need permission to continue
      agent.status = 'awaiting-permission';
      agent.updated = Date.now();
      this.emit('agent-needs-permission', agent);
      return;
    }
    
    // Store pending actions to be processed in parallel
    const pendingActions = [];
    
    // Prepare context information
    let actionContext = '';
    
    // Add results from other agents if they're complete
    if (task.plan && task.plan.workflow) {
      const otherAgentIds = task.agents.filter(id => id !== agent.id);
      
      for (const otherId of otherAgentIds) {
        const otherAgent = this.agents.get(otherId);
        if (otherAgent && otherAgent.results && otherAgent.results.length > 0) {
          // Only include completed agent results based on workflow dependencies
          actionContext += `\n## Results from ${otherAgent.role}\n`;
          
          // Add latest result
          const latestResult = otherAgent.results[otherAgent.results.length - 1];
          actionContext += latestResult.content || 'No content available.';
          actionContext += '\n';
        }
      }
    }
    
    // Add previous results from this agent
    if (agent.results && agent.results.length > 0) {
      actionContext += `\n## Your Previous Results\n`;
      agent.results.forEach((result, idx) => {
        actionContext += `\n### Result ${idx + 1}\n`;
        actionContext += result.content || 'No content available.';
        actionContext += '\n';
      });
    }
    
    // Process actions in parallel using worker threads
    const workerPromises = [];
    const pendingResults = new Map();
    
    // Create workers for each action in the batch
    for (let i = 0; i < batchSize; i++) {
      // Skip if we've exceeded max actions
      if (agent.actionsPerformed >= config.agentic.maxActionsPerAgent) {
        agent.status = 'awaiting-permission';
        agent.updated = Date.now();
        this.emit('agent-needs-permission', agent);
        return;
      }
      
      const actionIndex = i;
      const action = actions[actionIndex];
      
      // Update counts
      agent.actionsPerformed++;
      
      // Create a new worker
      const worker = new Worker(path.join(__dirname, 'worker.js'));
      
      // Create a promise to handle the worker completion
      const workerPromise = new Promise((resolve, reject) => {
        // Handle messages from the worker
        worker.on('message', (message) => {
          if (message.type === 'ready') {
            // Worker is ready, send the action to process
            worker.postMessage({
              type: 'process-action',
              data: {
                agent: { 
                  id: agent.id, 
                  role: agent.role, 
                  type: agent.type, 
                  goal: agent.goal,
                  provider: agent.provider,
                  model: agent.model
                },
                task: { 
                  id: task.id, 
                  description: task.description 
                },
                action,
                actionContext,
                actionIndex
              }
            });
          } else if (message.type === 'action-result') {
            // Store the result for this action index
            pendingResults.set(message.actionIndex, {
              success: message.result.success,
              content: message.result.result,
              error: message.result.error
            });
            
            // Terminate the worker
            worker.terminate();
            resolve();
          } else if (message.type === 'action-error') {
            // Store the error for this action index
            pendingResults.set(message.actionIndex, {
              success: false,
              content: null,
              error: message.error
            });
            
            // Terminate the worker
            worker.terminate();
            resolve();
          }
        });
        
        // Handle worker errors
        worker.on('error', (error) => {
          pendingResults.set(actionIndex, {
            success: false,
            content: null,
            error: error.message
          });
          
          worker.terminate();
          resolve();
        });
      });
      
      workerPromises.push(workerPromise);
    }
    
    // Wait for all workers to complete
    await Promise.all(workerPromises);
    
    // Process results in order
    for (let i = 0; i < batchSize; i++) {
      const result = pendingResults.get(i);
      const action = actions[i];
      
      if (result) {
        if (result.success) {
          // Store the successful result
          agent.results.push({
            type: 'action',
            action,
            content: result.content,
            timestamp: Date.now()
          });
          
          // Emit agent progress event
          this.emit('agent-progress', {
            agent,
            action,
            result: result.content,
            actionsRemaining: agent.actions.length - (i + 1)
          });
        } else {
          // Store the error
          agent.results.push({
            type: 'error',
            action,
            content: result.error,
            timestamp: Date.now()
          });
          
          // Emit error event
          this.emit('agent-error', {
            agent,
            action,
            error: result.error
          });
        }
      }
    }
    
    // Remove processed actions
    agent.actions = agent.actions.slice(batchSize);
    agent.updated = Date.now();
    
    // Check if agent has more actions to perform
    if (agent.actions.length > 0) {
      // Continue with next batch if we haven't hit the limit
      if (agent.actionsPerformed < config.agentic.maxActionsPerAgent) {
        // Schedule next batch
        setTimeout(() => {
          this.runAgentActions(agentId);
        }, 100);
      } else {
        // Need permission to continue
        agent.status = 'awaiting-permission';
        agent.updated = Date.now();
        this.emit('agent-needs-permission', agent);
      }
    } else {
      // Agent has completed all actions
      agent.status = 'completed';
      agent.updated = Date.now();
      
      // Check if task is complete
      this.checkTaskCompletion(agent.taskId);
      
      // Emit agent completion event
      this.emit('agent-completed', agent);
    }
  }
  
  // Grant permission to agent to continue working
  grantAgentPermission(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== 'awaiting-permission') return false;
    
    // Reset action counter and continue
    agent.actionsPerformed = 0;
    agent.status = 'working';
    agent.updated = Date.now();
    
    // Continue execution
    this.runAgentActions(agentId);
    
    return true;
  }
  
  // Check if all agents for a task have completed
  checkTaskCompletion(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    
    // Check if all agents are completed
    const allCompleted = task.agents.every(agentId => {
      const agent = this.agents.get(agentId);
      return agent && (agent.status === 'completed' || agent.status === 'error');
    });
    
    if (allCompleted) {
      // Find the conductor
      const conductorId = `${taskId}-conductor`;
      const conductor = this.agents.get(conductorId);
      
      if (conductor) {
        // Have the conductor summarize the results
        this.summarizeResults(taskId);
      } else {
        // No conductor, just mark the task as completed
        task.status = 'completed';
        task.completed = Date.now();
        task.updated = Date.now();
        
        // Update task history
        const historyEntry = this.taskHistory.find(t => t.id === taskId);
        if (historyEntry) {
          historyEntry.completed = Date.now();
          historyEntry.status = 'completed';
          this.saveTaskHistory();
        }
        
        // Emit task completion event
        this.emit('task-completed', task);
      }
    }
  }
  
  // Summarize task results using the conductor
  async summarizeResults(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    
    // Find the conductor
    const conductorId = `${taskId}-conductor`;
    const conductor = this.agents.get(conductorId);
    
    if (!conductor) return;
    
    // Update status
    conductor.status = 'summarizing';
    conductor.updated = Date.now();
    conductor.actionsPerformed++;
    
    task.status = 'summarizing';
    task.updated = Date.now();
    
    try {
      // Collect results from all agents
      let agentResults = '';
      
      for (const agentId of task.agents) {
        const agent = this.agents.get(agentId);
        
        if (agent && agent.results && agent.results.length > 0) {
          agentResults += `\n## Results from ${agent.role} (${agent.type})\n\n`;
          
          // Include all results
          agent.results.forEach((result, idx) => {
            if (result.type === 'action') {
              agentResults += `### Action ${idx + 1}: ${result.action}\n\n`;
              agentResults += result.content || 'No content available.';
              agentResults += '\n\n';
            }
          });
        }
      }
      
      // Create summarization prompt
      const summaryPrompt = `You are the conductor for a multi-agent task. All agents have completed their work, and now you need to synthesize their findings into a coherent final report.

## Original Task
${task.description}

## Task Plan
${JSON.stringify(task.plan, null, 2)}

## Agent Results
${agentResults}

## Your Task
Create a comprehensive summary of the results that:
1. Addresses the original task objectives
2. Synthesizes findings from all agents
3. Provides clear conclusions and recommendations
4. Highlights any limitations or areas for future work

The summary should be well-structured, concise but complete, and directly useful to the user who requested this task.`;
      
      // Get AI response based on the conductor's provider/model
      let summaryResponse;
      
      switch (conductor.provider) {
        case 'openai':
          if (!openai) throw new Error('OpenAI API key not configured');
          
          const openaiResponse = await openai.chat.completions.create({
            model: conductor.model,
            messages: [
              { role: 'system', content: 'You are an expert at synthesizing information from multiple sources into coherent summaries.' },
              { role: 'user', content: summaryPrompt }
            ],
            ...(!(conductor.model && typeof conductor.model === 'string' && conductor.model.startsWith('gpt-5')) ? { temperature: 0.3 } : {}),
          });
          
          summaryResponse = openaiResponse.choices[0].message.content;
          break;
          
        case 'anthropic':
          if (!anthropic) throw new Error('Anthropic API key not configured');
          
          const anthropicResponse = await anthropic.messages.create({
            model: conductor.model,
            system: 'You are an expert at synthesizing information from multiple sources into coherent summaries.',
            messages: [
              { role: 'user', content: summaryPrompt }
            ],
            max_tokens: 4000,
            temperature: 0.3,
          });
          
          summaryResponse = anthropicResponse.content[0].text;
          break;
          
        case 'google':
          if (!genAI) throw new Error('Google AI API key not configured');
          
          const systemPrompt = 'You are an expert at synthesizing information from multiple sources into coherent summaries.';
          const googleMessages = [systemPrompt, summaryPrompt].join('\n\n');
          const googleModel = genAI.getGenerativeModel({ model: conductor.model });
          const googleResponse = await googleModel.generateContent(googleMessages);
          
          summaryResponse = googleResponse.response.text();
          break;
          
        case 'openrouter':
          if (!openRouter) throw new Error('OpenRouter API key not configured');
          
          const openRouterResponse = await openRouter.chat.completions.create({
            model: conductor.model,
            system: 'You are an expert at synthesizing information from multiple sources into coherent summaries.',
            messages: [
              { role: 'user', content: summaryPrompt }
            ],
            temperature: 0.3,
          });
          
          summaryResponse = openRouterResponse.choices[0].message.content;
          break;
          
        default:
          throw new Error(`Unknown provider: ${conductor.provider}`);
      }
      
      // Store the summary
      conductor.results.push({
        type: 'summary',
        content: summaryResponse,
        timestamp: Date.now()
      });
      
      // Add to task results
      task.results.push({
        type: 'summary',
        content: summaryResponse,
        timestamp: Date.now()
      });
      
      // Mark task as completed
      task.status = 'completed';
      task.completed = Date.now();
      task.updated = Date.now();
      
      conductor.status = 'completed';
      conductor.updated = Date.now();
      
      // Update task history
      const historyEntry = this.taskHistory.find(t => t.id === taskId);
      if (historyEntry) {
        historyEntry.completed = Date.now();
        historyEntry.status = 'completed';
        this.saveTaskHistory();
      }
      
      // Emit task completion event
      this.emit('task-completed', { task, summary: summaryResponse });
      
    } catch (error) {
      console.error(`Error summarizing results: ${error.message}`);
      
      conductor.status = 'error';
      conductor.updated = Date.now();
      
      task.status = 'error';
      task.error = `Error summarizing results: ${error.message}`;
      task.updated = Date.now();
      
      this.emit('task-error', task);
    }
  }
  
  // Get a task by ID
  getTask(taskId) {
    return this.tasks.get(taskId);
  }
  
  // Get an agent by ID
  getAgent(agentId) {
    return this.agents.get(agentId);
  }
  
  // Get all agents for a task
  getTaskAgents(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return [];
    
    return task.agents.map(agentId => this.agents.get(agentId)).filter(agent => agent);
  }
  
  // Cancel a task
  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    
    // Update task status
    task.status = 'cancelled';
    task.updated = Date.now();
    
    // Update all agents for this task
    for (const agentId of task.agents) {
      const agent = this.agents.get(agentId);
      if (agent) {
        agent.status = 'cancelled';
        agent.updated = Date.now();
      }
    }
    
    // Update conductor
    const conductorId = `${taskId}-conductor`;
    const conductor = this.agents.get(conductorId);
    if (conductor) {
      conductor.status = 'cancelled';
      conductor.updated = Date.now();
    }
    
    // Update task history
    const historyEntry = this.taskHistory.find(t => t.id === taskId);
    if (historyEntry) {
      historyEntry.status = 'cancelled';
      this.saveTaskHistory();
    }
    
    // Emit task cancellation event
    this.emit('task-cancelled', task);
    
    return true;
  }
}

// Directory Analyzer for parallel file processing
class DirectoryAnalyzer extends EventEmitter {
  constructor(customConfig = null) {
    super();
    // Make sure we don't crash if config isn't loaded yet
    const effectiveConfig = customConfig || config || {};
    this.config = {
      maxParallelFileReads: effectiveConfig.agentic?.maxParallelFileReads || 10,
      chunkSize: effectiveConfig.agentic?.directoryAnalysisChunkSize || 5,
      allowedDirectories: effectiveConfig.agent?.allowedDirectories || [process.cwd()]
    };
    this.isRunning = false;
    this.results = {
      totalFiles: 0,
      analyzedFiles: 0,
      fileContents: {},
      errors: [],
      summary: ""
    };
    this.execPromise = promisify(exec);
  }

  // Check if path is within allowed directories
  isPathAllowed(dirPath) {
    const absolutePath = path.resolve(dirPath);
    const allowedDirs = this.config.allowedDirectories || [process.cwd()];
    return allowedDirs.some(allowedDir => 
      absolutePath === allowedDir || absolutePath.startsWith(allowedDir + path.sep)
    );
  }

  // Filter files based on importance
  categorizeFileImportance(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath).toLowerCase();
    
    // Skip binary files, node_modules, etc.
    if (['.jpg', '.png', '.gif', '.pdf', '.zip'].includes(ext) || 
        filePath.includes('node_modules') || 
        filePath.includes('.git') || 
        isPathIgnored(filePath, aiIgnorePatterns)) {
      return 'ignore';
    }
    
    // High priority files
    if (['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.java', '.c', '.cpp'].includes(ext) ||
        ['readme.md', 'package.json', 'cargo.toml', 'requirements.txt', 'dockerfile'].includes(basename)) {
      return 'high';
    }
    
    // Medium priority files
    if (['.md', '.txt', '.html', '.css', '.json', '.yaml', '.yml'].includes(ext)) {
      return 'medium';
    }
    
    // Low priority for everything else
    return 'low';
  }

  // List files in directory recursively
  async listFilesRecursively(dirPath) {
    try {
      if (!this.isPathAllowed(dirPath)) {
        throw new Error(`Directory not allowed: ${dirPath}`);
      }
      
      const absolutePath = path.resolve(dirPath);
      const result = await this.execPromise(`find "${absolutePath}" -type f | sort`);
      
      // Filter and categorize files
      const allFiles = result.stdout.split('\n').filter(Boolean);
      const categorized = {
        high: [],
        medium: [],
        low: []
      };
      
      allFiles.forEach(file => {
        const importance = this.categorizeFileImportance(file);
        if (importance !== 'ignore') {
          categorized[importance].push(file);
        }
      });
      
      // Order by importance
      return [...categorized.high, ...categorized.medium, ...categorized.low];
    } catch (error) {
      console.error(`Error listing files: ${error.message}`);
      throw error;
    }
  }

  // Read file contents
  async readFile(filePath) {
    try {
      if (isPathIgnored(filePath, aiIgnorePatterns)) {
        return { filePath, content: null, error: 'File is ignored by .aiignore' };
      }

      const stats = await fs.promises.stat(filePath);
      if (stats.size > 1024 * 1024) { // Skip files larger than 1MB
        return { filePath, content: null, error: 'File too large' };
      }

      const content = await fs.promises.readFile(filePath, 'utf8');
      return { filePath, content, error: null };
    } catch (error) {
      return { filePath, content: null, error: error.message };
    }
  }

  // Process files in parallel batches
  async processFilesBatch(files) {
    const { maxParallelFileReads } = this.config;
    const results = [];
    
    for (let i = 0; i < files.length; i += maxParallelFileReads) {
      const batch = files.slice(i, i + maxParallelFileReads);
      const batchPromises = batch.map(file => this.readFile(file));
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      this.results.analyzedFiles += batchResults.length;
      this.emit('progress', { 
        processed: this.results.analyzedFiles,
        total: this.results.totalFiles,
        percentage: Math.round((this.results.analyzedFiles / this.results.totalFiles) * 100)
      });
    }
    
    return results;
  }

  // Analyze directory content
  async analyzeDirectory(dirPath) {
    if (this.isRunning) {
      throw new Error('Directory analysis already in progress');
    }
    
    this.isRunning = true;
    this.results = {
      totalFiles: 0,
      analyzedFiles: 0,
      fileContents: {},
      errors: [],
      summary: ""
    };
    
    try {
      const files = await this.listFilesRecursively(dirPath);
      this.results.totalFiles = files.length;
      
      const fileResults = await this.processFilesBatch(files);
      
      // Process results
      fileResults.forEach(result => {
        if (result.error) {
          this.results.errors.push({ path: result.filePath, error: result.error });
        } else if (result.content !== null) {
          this.results.fileContents[result.filePath] = result.content;
        }
      });
      
      // Generate directory structure summary
      const structure = {};
      Object.keys(this.results.fileContents).forEach(filePath => {
        const relativePath = path.relative(dirPath, filePath);
        const parts = relativePath.split(path.sep);
        let current = structure;
        parts.forEach((part, index) => {
          if (index === parts.length - 1) {
            current[part] = 'file';
          } else {
            current[part] = current[part] || {};
            current = current[part];
          }
        });
      });
      
      this.results.summary = JSON.stringify(structure, null, 2);
      this.isRunning = false;
      
      this.emit('complete', { 
        totalFiles: this.results.totalFiles, 
        analyzedFiles: this.results.analyzedFiles,
        errors: this.results.errors.length 
      });
      
      return this.results;
    } catch (error) {
      this.isRunning = false;
      this.emit('error', error);
      throw error;
    }
  }
  
  // Get progress status
  getProgress() {
    return {
      isRunning: this.isRunning,
      processed: this.results.analyzedFiles,
      total: this.results.totalFiles,
      percentage: this.results.totalFiles ? 
        Math.round((this.results.analyzedFiles / this.results.totalFiles) * 100) : 0
    };
  }
}

// Create DirectoryAnalyzer instance
const directoryAnalyzer = new DirectoryAnalyzer(config);

// Make directory review functionality globally accessible
globalThis.directoryReview = async (input) => {
  if (globalThis.isReviewRequest(input)) {
    console.log(chalk.blue('Starting directory analysis...'));
    try {
      const dirPath = extractDirectoryPath(input);
      const results = await reviewDirectory(dirPath);
      
      if (results) {
        // Force using powerful model for analysis
        let prevAgenticMode = false;
        if (config && config.agentic) {
          prevAgenticMode = config.agentic.autoDetect;
          config.agentic.autoDetect = true;
        }
        
        return true;
      }
    } catch (error) {
      console.error('Directory review error:', error);
    }
  }
  
  return false;
};

// Initialize AI clients
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Anthropic client with validation
let anthropic;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
} else {
  console.warn(chalk.yellow('Warning: ANTHROPIC_API_KEY environment variable not set. Anthropic Claude will not be available.'));
}

// Initialize Google AI client with validation
let genAI;
if (process.env.GOOGLE_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
} else {
  console.warn(chalk.yellow('Warning: GOOGLE_API_KEY environment variable not set. Google AI will not be available.'));
}

// Initialize Commander
const program = new Command();

// Deep merge utility to preserve defaults when loading partial configs
function deepMerge(target, source) {
  if (typeof target !== 'object' || target === null) return source;
  if (typeof source !== 'object' || source === null) return target;
  const result = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source)) {
    const tVal = result[key];
    const sVal = source[key];
    if (Array.isArray(tVal) && Array.isArray(sVal)) {
      result[key] = sVal.slice();
    } else if (typeof tVal === 'object' && tVal && typeof sVal === 'object' && sVal) {
      result[key] = deepMerge(tVal, sVal);
    } else {
      result[key] = sVal;
    }
  }
  return result;
}

// ASCII art logo with gradient colors
function displayLogo() {
  console.clear();
  const logo = figlet.textSync('QA', {
    font: 'ANSI Shadow',
    horizontalLayout: 'full'
  });
  
  console.log(gradient.pastel.multiline(logo));
  console.log(chalk.cyan('Your AI Assistant Terminal'));
  try {
    const modes = [];
    modes.push(`Auto-scan: ${config?.autoActions?.localSearchBeforeAI ? chalk.green('On') : chalk.gray('Off')}`);
    modes.push(`Agentic: ${config?.agentic?.enabled ? chalk.green('On') : chalk.gray('Off')}`);
    modes.push(`Provider: ${chalk.yellow(config?.currentProvider || 'n/a')}`);
    console.log(chalk.gray(modes.join('  |  ')) + '\n');
  } catch {
    console.log('\n');
  }
}

// Load or create configuration file
function loadConfig() {
  try {
    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      const configData = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8');
      const loadedConfig = JSON.parse(configData);
      
      // Ensure all directory paths are absolute
      if (loadedConfig.agent && loadedConfig.agent.allowedDirectories) {
        loadedConfig.agent.allowedDirectories = loadedConfig.agent.allowedDirectories.map(dir => 
          path.isAbsolute(dir) ? dir : path.resolve(__dirname, dir)
        );
      }
      
      config = deepMerge(config, loadedConfig);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error loading config:', error.message);
    return false;
  }
}

// Save configuration
function saveConfig() {
  try {
    // Create a deep copy of config to avoid modifying the original
    const configToSave = JSON.parse(JSON.stringify(config));
    
    // Ensure all directory paths are absolute before saving
    if (configToSave.agent && configToSave.agent.allowedDirectories) {
      configToSave.agent.allowedDirectories = configToSave.agent.allowedDirectories.map(dir => 
        path.isAbsolute(dir) ? dir : path.resolve(__dirname, dir)
      );
    }
    
    fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(configToSave, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving config:', error.message);
    return false;
  }
}

// Format AI responses for better terminal display
function formatAIResponse(text) {
  // Process tool_code blocks in AI responses
  if (text.includes('```tool_code') && text.includes('{{agent:fs:write:')) {
    processToolCodeBlocks(text);
  }

  // Return text directly without boxen borders for easier copy/paste
  const out = text;
  // Track last AI response and session transcript for copying
  lastAIResponse = out;
  sessionTranscript.push(stripAnsi(out));
  return out;
}

// Extract shell commands from fenced code blocks in assistant text
function extractShellCommandsFromText(text) {
  const out = [];
  const regex = /```(?:bash|sh)?\n([\s\S]*?)```/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const block = m[1];
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    out.push(...lines);
  }
  return out;
}

// Execute a list of shell commands sequentially, handling persistent cd
async function runShellCommandsSequentially(commands) {
  for (const raw of commands) {
    const line = raw.trim();
    if (!line) continue;
    if (/^cd\s+/i.test(line)) {
      let target = line.replace(/^cd\s+/i, '').trim();
      if (target === '~') target = os.homedir();
      if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
      if (!path.isAbsolute(target)) target = path.resolve(currentWorkingDirectory, target);
      if (!fs.existsSync(target)) {
        try { fs.mkdirSync(target, { recursive: true }); } catch (e) { console.log(chalk.red(`Failed to create directory: ${e.message}`)); continue; }
      }
      currentWorkingDirectory = target;
      console.log(chalk.green(`Changed directory to: ${currentWorkingDirectory}`));
      continue;
    }
    try {
      const cmdPrefix = config.agent.useVirtualEnvironment ? 'docker run --rm alpine ' : '';
      const result = await executeCommand(cmdPrefix + line);
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.log(chalk.yellow(result.stderr));
    } catch (e) {
      console.log(chalk.red(`Error executing command '${line}': ${e.message}`));
    }
  }
}

// Handle intent: start a new coding project in <path>
async function handleStartNewProjectIntent(question) {
  const match = question.match(/start\s+(?:a\s+)?new\s+(?:coding\s+)?project\s+in\s+(.+)/i);
  if (!match) return false;
  const rawPath = match[1].trim();
  let target = rawPath.replace(/^`|`$/g, '');
  if (target === '~') target = os.homedir();
  if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
  if (!path.isAbsolute(target)) target = path.resolve(currentWorkingDirectory, target);

  try {
    fs.mkdirSync(target, { recursive: true });
    currentWorkingDirectory = target;
    console.log(chalk.green(`Initialized project directory: ${formatCwdForPrompt()}`));
  } catch (e) {
    console.log(chalk.red(`Failed to create project directory: ${e.message}`));
    return true;
  }

  // Initialize git (best-effort)
  try {
    await executeCommand('git init');
    console.log(chalk.green('Initialized empty Git repository'));
  } catch {}

  // Create structure
  try { fs.mkdirSync(path.join(currentWorkingDirectory, 'src'), { recursive: true }); } catch {}
  try { fs.mkdirSync(path.join(currentWorkingDirectory, 'tests'), { recursive: true }); } catch {}
  try { const p = path.join(currentWorkingDirectory, 'README.md'); if (!fs.existsSync(p)) fs.writeFileSync(p, '# New Project\n'); } catch {}
  try {
    const gi = path.join(currentWorkingDirectory, '.gitignore');
    const lines = ['node_modules/', '__pycache__/', '*.log'];
    let content = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    for (const ln of lines) { if (!content.includes(ln)) content += (content.endsWith('\n') ? '' : '\n') + ln + '\n'; }
    fs.writeFileSync(gi, content);
  } catch {}

  console.log(chalk.green('Project scaffold created: src/, tests/, README.md, .gitignore'));
  return true;
}
// Extract and execute agent commands from a text response (no prompts)
async function executeAgentCommandsFromText(text, options = {}) {
  const { autoCreateCdDir = true } = options;
  const singleCommandRegex = /(?:\{\{agent:(fs|exec):(.+?)\}\}|\(Executed: (.+?)\))/g;
  const commands = [];
  let m;
  while ((m = singleCommandRegex.exec(text)) !== null) {
    if (m[0].startsWith('{{agent:')) {
      commands.push({ type: m[1], cmd: m[2] });
    } else {
      const cmdText = m[3];
      const type = cmdText.startsWith('mkdir') || cmdText.startsWith('rm ') || cmdText.startsWith('cp ') || cmdText.startsWith('mv ') || cmdText.includes(':') ? 'fs' : 'exec';
      commands.push({ type, cmd: cmdText });
    }
  }

  for (const c of commands) {
    if (c.type === 'fs') {
      const parts = c.cmd.split(':');
      const operation = parts[0].trim();
      const filePath = (parts[1] || '').trim();
      const content = parts.length > 2 ? parts.slice(2).join(':').trim() : '';
      const result = await handleFileOperation(operation, { path: filePath, content });
      if (!result.success) console.log(chalk.red(`Error: ${result.error}`));
    } else {
      // exec command with special handling for cd
      const trimmed = c.cmd.trim();
      if (/^cd\s+/i.test(trimmed)) {
        // Handle persistent directory change
        let target = trimmed.replace(/^cd\s+/i, '').trim();
        if (target === '~') target = os.homedir();
        if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
        if (!path.isAbsolute(target)) target = path.resolve(currentWorkingDirectory, target);
        if (!fs.existsSync(target)) {
          if (autoCreateCdDir) {
            try { fs.mkdirSync(target, { recursive: true }); } catch (e) { console.log(chalk.red(`Failed to create directory: ${e.message}`)); continue; }
          } else {
            console.log(chalk.red(`Directory does not exist: ${target}`));
            continue;
          }
        }
        currentWorkingDirectory = target;
        console.log(chalk.green(`Changed directory to: ${currentWorkingDirectory}`));
        continue;
      }
      try {
        const cmdPrefix = config.agent.useVirtualEnvironment ? 'docker run --rm alpine ' : '';
        const result = await executeCommand(cmdPrefix + c.cmd);
        if (result.stderr) {
          console.log(chalk.yellow(result.stderr));
        }
        if (result.stdout) {
          console.log(result.stdout);
        }
      } catch (e) {
        console.log(chalk.red(`Error executing command: ${e.message}`));
      }
    }
  }
}

// Process tool_code blocks in AI responses
function processToolCodeBlocks(text) {
  // Match tool_code blocks with agent file write commands
  const toolCodeRegex = /```tool_code\s*\n\s*\{\{agent:fs:write:(.*?):([\s\S]*?)\}\}\s*\n\s*```/g;
  let match;
  
  while ((match = toolCodeRegex.exec(text)) !== null) {
    try {
      const filePath = match[1].trim();
      const fileContent = match[2];
      
      // Resolve the file path relative to the current working directory
      const resolvedPath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(currentWorkingDirectory, filePath);
      
      console.log(chalk.cyan(`Writing file: ${resolvedPath}`));
      
      // Write the file using our file operation handler
      const result = handleFileOperation('write', {
        path: resolvedPath,
        content: fileContent
      });
      
      if (result.success) {
        console.log(chalk.green(`✓ Successfully wrote file: ${resolvedPath}`));
      } else {
        console.log(chalk.red(`✗ Failed to write file: ${result.error}`));
      }
    } catch (error) {
      console.error(chalk.red(`Error processing file write command: ${error.message}`));
    }
  }
}

// Format user messages for display
function formatUserMessage(text) {
  const rendered = chalk.green('You: ') + chalk.white(text);
  sessionTranscript.push(`You: ${text}`);
  return rendered;
}

// Agent capabilities - file system operations
// Note: Using loadAiIgnorePatterns defined above
// Note: isPathIgnored function is defined at the top of the file

async function handleFileOperation(operation, params) {
  // Validate operation is allowed
  const allowedOperations = ['read', 'write', 'list', 'exists'];
  if (!allowedOperations.includes(operation)) {
    return { success: false, error: `Operation ${operation} not allowed` };
  }

  // Resolve path relative to current working directory 
  let resolvedPath = params.path;
  if (!path.isAbsolute(resolvedPath)) {
    resolvedPath = path.join(currentWorkingDirectory, resolvedPath);
  }
  
  const filePath = path.resolve(resolvedPath);
  
  // No directory restrictions - allowed to access any directory where the app is run from
  // Optional basic validation to prevent accessing system directories could be added here
  
  // Load .aiignore patterns if not already loaded
  if (aiIgnorePatterns.length === 0 || operation === 'list') {
    // Try loading from both places: the current directory and the installation directory
    loadAiIgnorePatterns(currentWorkingDirectory);
    if (aiIgnorePatterns.length === 0) {
      loadAiIgnorePatterns(installDir);
    }
  }
  
  // Check if path is ignored (except for exists operation)
  if (operation !== 'exists' && isPathIgnored(filePath, aiIgnorePatterns)) {
    return { 
      success: false, 
      error: `Access to ${filePath} is blocked by .aiignore rules. This file or directory is restricted.`
    };
  }

  try {
    switch (operation) {
      case 'read':
        const content = fs.readFileSync(filePath, 'utf8');
        return { success: true, data: content };
      
      case 'write':
        fs.writeFileSync(filePath, params.content);
        return { success: true, message: `File ${filePath} written successfully` };
      
      case 'list':
        const items = fs.readdirSync(filePath);
        return { success: true, data: items };
      
      case 'exists':
        const exists = fs.existsSync(filePath);
        return { success: true, data: exists };
        
      default:
        return { success: false, error: 'Invalid operation' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Agent capabilities - terminal command execution
function isCommandAllowed(command) {
  return !config.agent.disallowedCommands.some(disallowed => 
    command.toLowerCase().includes(disallowed.toLowerCase())
  );
}

function isDangerousExec(command) {
  const c = (command || '').toLowerCase();
  return /(\brm\b|\brmdir\b|\brd\b|\bdel\b|remove-item|\bmkfs\b|\bdd\s+if=|format\s)/.test(c);
}

function executeCommand(command, useTerminalMode = false) {
  return new Promise((resolve, reject) => {
    if (!isCommandAllowed(command)) {
      reject(new Error(`Command contains disallowed operations: ${command}`));
      return;
    }
    
    // If it's a cd command in terminal mode, handle directory change
    if (useTerminalMode && command.trim().startsWith('cd ')) {
      try {
        const newDir = command.trim().substring(3).trim();
        let targetDir;
        
        // Handle special cases
        if (newDir === '~') {
          targetDir = os.homedir();
        } else if (newDir.startsWith('/')) {
          // Absolute path
          targetDir = newDir;
        } else {
          // Relative path
          targetDir = path.resolve(currentWorkingDirectory, newDir);
        }
        
        // Verify the target directory is within allowed directories
        const isAllowed = config.agent.allowedDirectories.some(dir => 
          targetDir.startsWith(path.resolve(dir))
        );
        
        if (!isAllowed) {
          reject(new Error(`Access to ${targetDir} is not allowed. Only paths within ${config.agent.allowedDirectories.join(', ')} are permitted.`));
          return;
        }
        
        // Check if directory exists
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
          reject(new Error(`Directory does not exist: ${targetDir}`));
          return;
        }
        
        // Update current working directory
        currentWorkingDirectory = targetDir;
        resolve({
          stdout: `Changed directory to: ${targetDir}`,
          stderr: '',
          success: true
        });
        return;
      } catch (error) {
        reject(error);
        return;
      }
    }
    
    // Always use the current working directory
    const execOptions = { 
      cwd: currentWorkingDirectory
    };
    
    exec(command, execOptions, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      
      resolve({
        stdout,
        stderr,
        success: !stderr
      });
    });
  });
}

// Translate simple natural language instructions to shell commands
function translateNaturalCommand(input) {
  const text = input.trim();
  const home = os.homedir();
  const expandTilde = (p) => p.replace(/^~(\b|\/)/, home + (p.startsWith('~/') ? '/' : ''));
  const quote = (p) => '"' + p.replace(/"/g, '\\"') + '"';
  const isWin = process.platform === 'win32';

  const openCmd = (p) => {
    if (isWin) return `powershell -NoProfile -Command Start-Process -FilePath ${quote(p)}`;
    if (process.platform === 'darwin') return `open ${quote(p)}`;
    return `xdg-open ${quote(p)}`;
  };

  const copyCmd = (src, dst, recursive = false) => {
    if (isWin) return `powershell -NoProfile -Command Copy-Item -Path ${quote(src)} -Destination ${quote(dst)}${recursive ? ' -Recurse' : ''}`;
    return `cp ${recursive ? '-R ' : ''}${quote(src)} ${quote(dst)}`;
  };

  const moveCmd = (src, dst) => {
    if (isWin) return `powershell -NoProfile -Command Move-Item -Path ${quote(src)} -Destination ${quote(dst)}`;
    return `mv ${quote(src)} ${quote(dst)}`;
  };

  const zipCmd = (src, dstZip) => {
    if (isWin) return `powershell -NoProfile -Command Compress-Archive -Path ${quote(src)} -DestinationPath ${quote(dstZip)}`;
    return `zip -r ${quote(dstZip)} ${quote(src)}`;
  };

  const unzipCmd = (zipFile, destDir) => {
    if (isWin) return `powershell -NoProfile -Command Expand-Archive -Path ${quote(zipFile)} -DestinationPath ${quote(destDir)}`;
    return `unzip ${quote(zipFile)} -d ${quote(destDir)}`;
  };

  // Split arguments by spaces but keep quoted chunks together
  const splitArgs = (s) => {
    const out = [];
    let cur = '';
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === q) { q = null; } else { cur += ch; }
      } else if (ch === '"' || ch === '\'') {
        q = ch;
      } else if (/\s/.test(ch)) {
        if (cur) { out.push(cur); cur = ''; }
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
    return out;
  };

  // make/create directory
  let m = text.match(/^(?:make|create)\s+(?:a\s+)?(?:new\s+)?dir(?:ectory)?(?:\s+(?:called|named))?\s+(.+)$/i);
  if (m) {
    const raw = m[1].trim();
    const pathArg = expandTilde(raw);
    return { cmd: `mkdir -p ${quote(pathArg)}`, explanation: 'Create directory' };
  }

  // list files in <path>
  m = text.match(/^(?:list\s+(?:all\s+)?files|show\s+(?:me\s+)?(?:the\s+)?files)\s+(?:in|at)\s+(.+)$/i);
  if (m) {
    const raw = m[1].trim();
    const pathArg = expandTilde(raw);
    return { cmd: `ls -la ${quote(pathArg)}`, explanation: 'List files' };
  }

  // list files (no path)
  m = text.match(/^(?:list\s+(?:all\s+)?files|show\s+(?:me\s+)?files)$/i);
  if (m) {
    return { cmd: `ls -la`, explanation: 'List files' };
  }

  // create file <path>
  m = text.match(/^(?:create|make)\s+(?:a\s+)?file\s+(.+)$/i);
  if (m) {
    const raw = m[1].trim();
    const pathArg = expandTilde(raw);
    return { cmd: `touch ${quote(pathArg)}`, explanation: 'Create file' };
  }

  // copy multiple files to dest: copy a b c to dest
  m = text.match(/^copy\s+(.+?)\s+to\s+(.+)$/i);
  if (m) {
    const srcChunk = m[1].trim();
    const dstRaw = m[2].trim();
    const parts = splitArgs(srcChunk);
    const dst = expandTilde(dstRaw);
    if (parts.length > 1) {
      const srcs = parts.map(s => quote(expandTilde(s))).join(isWin ? ', ' : ' ');
      const cmd = isWin
        ? `powershell -NoProfile -Command Copy-Item -Path ${srcs} -Destination ${quote(dst)}`
        : `cp ${parts.map(s => quote(expandTilde(s))).join(' ')} ${quote(dst)}`;
      return { cmd, explanation: 'Copy items' };
    }
    // Falls through to single copy handled below if only one src
  }

  // copy <src> to <dest>
  m = text.match(/^copy\s+(.+?)\s+to\s+(.+)$/i);
  if (m) {
    const src = expandTilde(m[1].trim());
    const dst = expandTilde(m[2].trim());
    return { cmd: copyCmd(src, dst, false), explanation: 'Copy file' };
  }

  // copy folder/dir <src> to <dest>
  m = text.match(/^copy\s+(?:folder|dir|directory)\s+(.+?)\s+to\s+(.+)$/i);
  if (m) {
    const src = expandTilde(m[1].trim());
    const dst = expandTilde(m[2].trim());
    return { cmd: copyCmd(src, dst, true), explanation: 'Copy directory' };
  }

  // move/rename <src> to <dest>
  m = text.match(/^(?:move|rename)\s+(.+?)\s+to\s+(.+)$/i);
  if (m) {
    const src = expandTilde(m[1].trim());
    const dst = expandTilde(m[2].trim());
    return { cmd: moveCmd(src, dst), explanation: 'Move/Rename' };
  }

  // open <path>
  m = text.match(/^(?:open|show)\s+(.+)$/i);
  if (m) {
    const p = expandTilde(m[1].trim());
    return { cmd: openCmd(p), explanation: 'Open path' };
  }

  // open in code <path>
  m = text.match(/^open\s+(?:in\s+)?(?:code|vscode)\s+(.+)$/i);
  if (m) {
    const p = expandTilde(m[1].trim());
    return { cmd: `code ${quote(p)}`, explanation: 'Open in VS Code' };
  }

  // open terminal here/in <path>
  m = text.match(/^open\s+(?:a\s+)?terminal(?:\s+(?:here|in)\s+(.+))?$/i);
  if (m) {
    const p = expandTilde((m[1] || currentWorkingDirectory).trim());
    let cmd;
    if (process.platform === 'darwin') {
      const esc = p.replace(/"/g, '\\"');
      cmd = `osascript -e "tell application \"Terminal\" to do script \"cd \"\"${esc}\"\"\""`;
    } else if (isWin) {
      cmd = `powershell -NoProfile -Command Start-Process wt -ArgumentList \"-d ${p}\"`;
    } else {
      // Try common terminals; fallback to xdg-open as best-effort
      cmd = `bash -lc 'if command -v gnome-terminal >/dev/null 2>&1; then gnome-terminal --working-directory=${quote(p)}; elif command -v konsole >/dev/null 2>&1; then konsole --workdir ${quote(p)}; elif command -v xterm >/dev/null 2>&1; then xterm -e bash -lc "cd ${p.replace(/"/g, '\\"')}; exec bash"; else xdg-open ${quote(p)}; fi'`;
    }
    return { cmd, explanation: 'Open terminal at path' };
  }

  // open finder/explorer/file manager here/in <path>
  m = text.match(/^open\s+(?:finder|explorer|file\s+manager)(?:\s+(?:here|in)\s+(.+))?$/i);
  if (m) {
    const p = expandTilde((m[1] || currentWorkingDirectory).trim());
    if (isWin) return { cmd: `explorer ${quote(p)}`, explanation: 'Open Explorer' };
    if (process.platform === 'darwin') return { cmd: `open ${quote(p)}`, explanation: 'Open Finder' };
    return { cmd: `xdg-open ${quote(p)}`, explanation: 'Open file manager' };
  }

  // zip with exclusions: zip <src> without <pat1> [and <pat2> ...]
  m = text.match(/^zip\s+(.+?)\s+without\s+(.+)$/i);
  if (m) {
    const src = expandTilde(m[1].trim());
    const exclRaw = m[2].trim();
    const patterns = exclRaw.split(/\s*(?:,|and)\s*/i).map(s => s.trim()).filter(Boolean);
    const base = path.basename(src.replace(/[\/]+$/, '')) || 'archive';
    const zipf = base.endsWith('.zip') ? base : `${base}.zip`;
    if (isWin) {
      // Best-effort: PowerShell Compress-Archive lacks straightforward excludes
      const note = ' (exclusions not applied on Windows)';
      return { cmd: zipCmd(src, zipf), explanation: 'Create archive' + note };
    } else {
      const excludes = patterns.map(p => `-x "**/${p.replace(/^\*+/, '')}/*"`).join(' ');
      return { cmd: `zip -r ${quote(zipf)} ${quote(src)} ${excludes}`.trim(), explanation: 'Create archive with exclusions' };
    }
  }

  // FORCE DELETE (guarded): force delete/remove <path>
  m = text.match(/^(?:force\s+)?(?:delete|remove)\s+(?:recursively\s+)?(?:force\s+)?(.+)$/i);
  if (m) {
    const p = expandTilde(m[1].trim());
    const cmd = isWin
      ? `powershell -NoProfile -Command Remove-Item -LiteralPath ${quote(p)} -Recurse -Force`
      : `rm -rf ${quote(p)}`;
    return { cmd, explanation: 'Force delete', danger: true, target: p };
  }

  // zip <src> to <zipfile>
  m = text.match(/^zip\s+(.+?)\s+(?:to|into|as)\s+(.+)$/i);
  if (m) {
    const src = expandTilde(m[1].trim());
    let zipf = expandTilde(m[2].trim());
    if (!zipf.toLowerCase().endsWith('.zip')) zipf += '.zip';
    return { cmd: zipCmd(src, zipf), explanation: 'Create archive' };
  }

  // zip <src>
  m = text.match(/^zip\s+(.+)$/i);
  if (m) {
    const src = expandTilde(m[1].trim());
    // derive default zip name
    const base = path.basename(src.replace(/[\/]+$/, '')) || 'archive';
    const zipf = base.endsWith('.zip') ? base : `${base}.zip`;
    return { cmd: zipCmd(src, zipf), explanation: 'Create archive' };
  }

  // zip each of a b c / zip a b c into zips
  m = text.match(/^zip\s+(?:each\s+of\s+)?(.+?)\s+(?:into\s+(?:separate\s+)?zips|as\s+(?:separate\s+)?zips)$/i)
    || text.match(/^zip\s+each\s+of\s+(.+)$/i);
  if (m) {
    const parts = splitArgs(m[1].trim()).map(s => expandTilde(s));
    if (parts.length > 1) {
      if (isWin) {
        const arr = parts.map(p => '"' + p.replace(/"/g, '\\"') + '"').join(',');
        const script = `powershell -NoProfile -Command $items=@(${arr}); foreach($p in $items){ $bn=Split-Path -Leaf $p; $zip=($bn -like '*.zip') ? $bn : ($bn + '.zip'); Compress-Archive -Path $p -DestinationPath $zip }`;
        return { cmd: script, explanation: 'Batch zip items' };
      } else {
        const cmds = parts.map(p => {
          const bn = path.basename(p).replace(/"/g, '\\"');
          const zipf = bn.endsWith('.zip') ? bn : `${bn}.zip`;
          return `zip -r "${zipf}" ${quote(p)}`;
        }).join(' && ');
        return { cmd: cmds, explanation: 'Batch zip items' };
      }
    }
  }

  // find files matching <glob> in/under <path>
  m = text.match(/^find\s+files\s+matching\s+(.+?)\s+(?:in|under)\s+(.+)$/i)
    || text.match(/^find\s+(.+?)\s+in\s+(.+)$/i);
  if (m) {
    const pattern = m[1].trim();
    const where = expandTilde(m[2].trim());
    if (isWin) {
      return { cmd: `powershell -NoProfile -Command Get-ChildItem -Path ${quote(where)} -Recurse -Filter ${quote(pattern)} | Select-Object -ExpandProperty FullName`, explanation: 'Find files' };
    } else {
      return { cmd: `find ${quote(where)} -type f -name ${quote(pattern)}`, explanation: 'Find files' };
    }
  }

  // replace 'old' with 'new' in file <path>
  m = text.match(/^replace\s+['\"]?(.+?)['\"]?\s+with\s+['\"]?(.+?)['\"]?\s+in\s+file\s+(.+)$/i);
  if (m) {
    const oldS = m[1];
    const newS = m[2];
    const file = expandTilde(m[3].trim());
    let cmd;
    if (isWin) {
      cmd = `powershell -NoProfile -Command (Get-Content ${quote(file)}) -replace ${quote(oldS)}, ${quote(newS)} | Set-Content ${quote(file)}`;
    } else if (process.platform === 'darwin') {
      cmd = `sed -i '' 's/${oldS.replace(/\//g,'\\/').replace(/'/g,"'\\''")}/${newS.replace(/\//g,'\\/').replace(/'/g,"'\\''")}/g' ${quote(file)}`;
    } else {
      cmd = `sed -i 's/${oldS.replace(/\//g,'\\/').replace(/'/g,"'\\''")}/${newS.replace(/\//g,'\\/').replace(/'/g,"'\\''")}/g' ${quote(file)}`;
    }
    return { cmd, explanation: 'In-place replace', confirmWord: 'APPLY', confirmMessage: `This will modify: ${file}\nType APPLY to proceed:` };
  }

  // replace 'old' with 'new' in files matching <glob> under <dir>
  m = text.match(/^replace\s+['\"]?(.+?)['\"]?\s+with\s+['\"]?(.+?)['\"]?\s+in\s+files\s+matching\s+(.+?)\s+under\s+(.+)$/i);
  if (m) {
    const oldS = m[1];
    const newS = m[2];
    const glob = m[3].trim();
    const dir = expandTilde(m[4].trim());
    let cmd;
    if (isWin) {
      cmd = `powershell -NoProfile -Command Get-ChildItem -Path ${quote(dir)} -Recurse -Filter ${quote(glob)} | ForEach-Object { (Get-Content $_.FullName) -replace ${quote(oldS)}, ${quote(newS)} | Set-Content $_.FullName }`;
    } else if (process.platform === 'darwin') {
      cmd = `find ${quote(dir)} -type f -name ${quote(glob)} -exec sed -i '' 's/${oldS.replace(/\//g,'\\/').replace(/'/g,"'\\''")}/${newS.replace(/\//g,'\\/').replace(/'/g,"'\\''")}/g' {} +`;
    } else {
      cmd = `find ${quote(dir)} -type f -name ${quote(glob)} -exec sed -i 's/${oldS.replace(/\//g,'\\/').replace(/'/g,"'\\''")}/${newS.replace(/\//g,'\\/').replace(/'/g,"'\\''")}/g' {} +`;
    }
    return { cmd, explanation: 'Batch replace', confirmWord: 'APPLY', confirmMessage: `This will modify multiple files under: ${dir}\nType APPLY to proceed:` };
  }

  // unzip <zipfile> to <dest>
  m = text.match(/^unzip\s+(.+?)\s+(?:to|into)\s+(.+)$/i);
  if (m) {
    const zipf = expandTilde(m[1].trim());
    const dest = expandTilde(m[2].trim());
    return { cmd: unzipCmd(zipf, dest), explanation: 'Extract archive' };
  }

  // unzip <zipfile>
  m = text.match(/^unzip\s+(.+)$/i);
  if (m) {
    const zipf = expandTilde(m[1].trim());
    const dest = currentWorkingDirectory;
    return { cmd: unzipCmd(zipf, dest), explanation: 'Extract archive' };
  }

  // remove directory <path>
  m = text.match(/^(?:remove|delete)\s+(?:the\s+)?dir(?:ectory)?\s+(.+)$/i);
  if (m) {
    const raw = m[1].trim();
    const pathArg = expandTilde(raw);
    return { cmd: `rmdir ${quote(pathArg)}`, explanation: 'Remove directory' };
  }

  // show file <path>
  m = text.match(/^(?:show|view|print)\s+(?:the\s+)?file\s+(.+)$/i);
  if (m) {
    const raw = m[1].trim();
    const pathArg = expandTilde(raw);
    return { cmd: `sed -n '1,200p' ${quote(pathArg)}`, explanation: 'Show file (first 200 lines)' };
  }

  return null;
}

// Function to apply reasoning steps to arrive at better answers
async function applyReasoningIterations(question, initialMessages, provider, model) {
  try {
    // Create a new context just for the reasoning steps
    let reasoningContext = [...initialMessages];
    
    // Add the reasoning instruction to the system message
    const systemMessageIndex = reasoningContext.findIndex(msg => msg.role === 'system');
    if (systemMessageIndex >= 0) {
      const originalContent = reasoningContext[systemMessageIndex].content;
      reasoningContext[systemMessageIndex].content = 
        `${originalContent} In this task, I want you to use multi-step reasoning to solve complex problems. 
        First, break down the problem into smaller parts. Then, tackle each part systematically. 
        Consider multiple approaches and evaluate them. Generate intermediate insights before your final answer.`;
    }
    
    // Add initial query
    reasoningContext.push({ role: 'user', content: question });
    
    let currentAnswer = '';
    let intermediateResponses = [];
    
    // Perform the reasoning iterations
    for (let i = 0; i < config.reasoningMode.iterations; i++) {
      let iterationPrompt;
      
      if (i === 0) {
        iterationPrompt = 'Think step-by-step about this problem. What are the key components we need to understand?';
      } else {
        iterationPrompt = `Based on your previous analysis, refine your thinking. Consider if there are any gaps, errors, or alternative perspectives. Iteration ${i+1}/${config.reasoningMode.iterations}.`;
      }
      
      // Add the refinement prompt
      reasoningContext.push({ role: 'user', content: iterationPrompt });
      
      // Get model response for this iteration
      let iterationResponse = '';
      
      switch (provider) {
        case 'openai':
          const openaiResponse = await openai.chat.completions.create({
            model: model,
            messages: reasoningContext.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            })),
            ...(!(model && typeof model === 'string' && model.startsWith('gpt-5')) ? { temperature: 0.7 } : {}),
          });
          
          iterationResponse = openaiResponse.choices[0].message.content;
          break;
          
        case 'anthropic':
          if (!anthropic) {
            throw new Error('Anthropic API key not set or invalid. Please check your ANTHROPIC_API_KEY environment variable.');
          }
          
          // Extract system message if present
          const anthropicSystemMsg = reasoningContext.find(msg => msg.role === 'system')?.content || '';
          
          // Create messages array without system message
          const anthropicReasoningMessages = reasoningContext
            .filter(msg => msg.role !== 'system')
            .map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            }));
          
          const anthropicResponse = await anthropic.messages.create({
            model: model,
            system: anthropicSystemMsg,
            messages: anthropicReasoningMessages,
            max_tokens: 1024,
            temperature: 0.7,
          });
          
          iterationResponse = anthropicResponse.content[0].text;
          break;
          
        case 'google':
          if (!genAI) {
            throw new Error('Google API key not set or invalid. Please check your GOOGLE_API_KEY environment variable.');
          }
          const systemPrompt = reasoningContext.find(msg => msg.role === 'system')?.content || '';
          
          const googleMessages = [
            systemPrompt,
            ...reasoningContext.filter(msg => msg.role !== 'system').map(msg => 
              `${msg.role === 'user' ? 'User: ' : 'Assistant: '}${msg.content}`
            )
          ].join('\n\n');
          
          const googleModel = genAI.getGenerativeModel({ model: model });
          const googleResponse = await googleModel.generateContent(googleMessages);
          
          iterationResponse = googleResponse.response.text();
          break;
          
        case 'openrouter':
          if (!openRouter) {
            throw new Error('OpenRouter API key not set or invalid. Please check your OPENROUTER_API_KEY environment variable.');
          }
          const openRouterResponse = await openRouter.chat.completions.create({
            model: model,
            messages: reasoningContext.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            })),
            temperature: 0.7,
          });
          
          iterationResponse = openRouterResponse.choices[0].message.content;
          break;
      }
      
      // Store the intermediate response
      reasoningContext.push({ role: 'assistant', content: iterationResponse });
      intermediateResponses.push(iterationResponse);
      
      // Update our current answer
      currentAnswer = iterationResponse;
    }
    
    // Final iteration - summarize the reasoning
    reasoningContext.push({ 
      role: 'user', 
      content: 'Based on all your reasoning steps, provide a concise and complete final answer to the original question.' 
    });
    
    // Get final response
    let finalResponse = '';
    
    switch (provider) {
      case 'openai':
        const openaiResponse = await openai.chat.completions.create({
          model: model,
          messages: reasoningContext.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          })),
          ...(!(model && typeof model === 'string' && model.startsWith('gpt-5')) ? { temperature: 0.7 } : {}),
        });
        
        finalResponse = openaiResponse.choices[0].message.content;
        break;
        
      case 'anthropic':
        if (!anthropic) {
          throw new Error('Anthropic API key not set or invalid. Please check your ANTHROPIC_API_KEY environment variable.');
        }
        const anthropicResponse = await anthropic.messages.create({
          model: model,
          messages: reasoningContext.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          })),
          max_tokens: 1024,
          temperature: 0.7,
        });
        
        finalResponse = anthropicResponse.content[0].text;
        break;
        
      case 'google':
        if (!genAI) {
          throw new Error('Google API key not set or invalid. Please check your GOOGLE_API_KEY environment variable.');
        }
        const systemPrompt = reasoningContext.find(msg => msg.role === 'system')?.content || '';
        
        const googleMessages = [
          systemPrompt,
          ...reasoningContext.filter(msg => msg.role !== 'system').map(msg => 
            `${msg.role === 'user' ? 'User: ' : 'Assistant: '}${msg.content}`
          )
        ].join('\n\n');
        
        const googleModel = genAI.getGenerativeModel({ model: model });
        const googleResponse = await googleModel.generateContent(googleMessages);
        
        finalResponse = googleResponse.response.text();
        break;
        
      case 'openrouter':
        if (!openRouter) {
          throw new Error('OpenRouter API key not set or invalid. Please check your OPENROUTER_API_KEY environment variable.');
        }
        const openRouterFinalResponse = await openRouter.chat.completions.create({
          model: model,
          messages: reasoningContext.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          })),
          temperature: 0.7,
        });
        
        finalResponse = openRouterFinalResponse.choices[0].message.content;
        break;
    }
    
    return {
      finalResponse,
      intermediateResponses
    };
    
  } catch (error) {
    console.error(chalk.red('Error in reasoning mode:'), error.message);
    return { 
      finalResponse: 'Error in reasoning mode: ' + error.message,
      intermediateResponses: []
    };
  }
}

// Check if a query is a direct command that can be executed without reasoning
function isDirectCommand(question) {
  // Patterns for simple file operations and listing requests
  const fileListingPatterns = [
    /list (?:the )?(?:files|directories|contents|items) in/i,
    /show (?:the )?(?:files|directories|contents|items) in/i,
    /what(?:'s| is) in (?:the )?(?:directory|folder|path)/i,
    /display (?:the )?content(?:s)? of (?:the )?(?:directory|folder|path)/i,
    /ls .*(?:\/[\w\s'"'.()-]+)+/i,
    /dir .*(?:\/[\w\s'"'.()-]+)+/i,
    /please list out/i,
    /can you list/i,
    /show me the files/i,
    /what files are in/i,
    /what's inside/i,
    /list files/i,
    /list directories/i,
    /list items/i
  ];
  
  // Patterns for simple file read requests
  const fileReadPatterns = [
    /(?:read|open|show|display|cat) (?:the )?(?:file|content(?:s)? of) ['""]?[\w\s\/\.-]+['""]?/i,
    /what(?:'s| is) in (?:the )?file/i,
    /cat .*(?:\/[\w\s'"'.()-]+)+/i,
    /what's the content of/i,
    /show me the content(?:s)? of/i
  ];
  
  // Patterns for simple file write requests
  const fileWritePatterns = [
    /(?:write|save|create) (?:to )?(?:the )?file/i,
    /make a (?:new )?file/i,
    /touch .*(?:\/[\w\s'"'.()-]+)+/i,
    /create a new file/i,
    /add content to (?:the )?file/i
  ];
  
  // Common terminal command patterns
  const terminalCommandPatterns = [
    /run (?:the )?command/i,
    /execute (?:the )?command/i,
    /can you run/i,
    /please run/i,
    /please execute/i
  ];
  
  // Check file listing patterns
  for (const pattern of fileListingPatterns) {
    if (pattern.test(question)) {
      return {
        isCommand: true,
        commandType: 'listing',
        confidence: 0.95
      };
    }
  }
  
  // Check file read patterns
  for (const pattern of fileReadPatterns) {
    if (pattern.test(question)) {
      return {
        isCommand: true,
        commandType: 'read',
        confidence: 0.9
      };
    }
  }
  
  // Check file write patterns
  for (const pattern of fileWritePatterns) {
    if (pattern.test(question)) {
      return {
        isCommand: true,
        commandType: 'write',
        confidence: 0.9
      };
    }
  }
  
  // Check terminal command patterns
  for (const pattern of terminalCommandPatterns) {
    if (pattern.test(question)) {
      return {
        isCommand: true,
        commandType: 'terminal',
        confidence: 0.9
      };
    }
  }
  
  // Extract path-like structures that might indicate file operations
  const pathPattern = /(?:\/[\w\s'"'.()-]+)+/g;
  const pathMatches = question.match(pathPattern);
  
  if (pathMatches && pathMatches.length > 0) {
    // If the question is short and contains a path, likely a direct command
    if (question.split(' ').length < 10) {
      return {
        isCommand: true,
        commandType: 'path-operation',
        confidence: 0.8
      };
    }
  }
  
  return {
    isCommand: false,
    commandType: null,
    confidence: 0
  };
}

// Analyze query complexity and determine if it needs a more powerful model
async function analyzeQueryComplexity(question) {
  try {
    // First check if this is a direct command that should be handled simply
    const commandCheck = isDirectCommand(question);
    if (commandCheck.isCommand && commandCheck.confidence > 0.7) {
      return {
        isComplex: false,
        confidence: commandCheck.confidence,
        isDirectCommand: true
      };
    }
    
    // Define prompt for query classifier
    const classifierPrompt = `
You are a query classifier AI. Your task is to determine if the following query requires a powerful AI model.

Complex queries that need powerful models:
1. Coding tasks or programming questions
2. Deep research questions requiring comprehensive knowledge
3. Queries asking for detailed analysis of complex subjects
4. Requests for creative content like stories, poems, or detailed content
5. Web search related questions or requests for current information
6. Multi-step reasoning problems

Simple queries that lightweight models can handle:
1. Basic factual questions
2. Simple definitions
3. Straightforward opinions
4. Basic instructions or how-to questions 
5. Simple conversational replies
6. Clarification questions
7. File system operations like listing directories, reading files, etc.
8. Basic terminal commands
9. Requests to show or display information

User query: "${question}"

IMPORTANT: If the query is asking to list files, show directory contents, read a file, or execute a simple command, classify it as SIMPLE.

First, analyze the complexity of this query. Then output ONLY ONE of these classifications:
- SIMPLE (can be handled by a lightweight model)
- COMPLEX (should be routed to a powerful model)

Also provide a confidence score between 0 and 1 for your classification.

Output format:
CLASSIFICATION: [SIMPLE or COMPLEX]
CONFIDENCE: [0.0-1.0]
`;

    // Get classification based on the current provider
    let classification = 'COMPLEX';  // Default to complex
    let confidence = 1.0;
    
    switch (config.currentProvider) {
      case 'openai':
        const openaiClassifierResponse = await openai.chat.completions.create({
          model: config.lightModels.openai,
          messages: [
            { role: 'system', content: 'You are a helpful query classifier.' },
            { role: 'user', content: classifierPrompt }
          ],
          ...(!(config.lightModels.openai && typeof config.lightModels.openai === 'string' && config.lightModels.openai.startsWith('gpt-5')) ? { temperature: 0.1 } : {}),
        });
        
        const openaiResult = openaiClassifierResponse.choices[0].message.content;
        // Parse the result
        const openaiClassMatch = openaiResult.match(/CLASSIFICATION:\s*(SIMPLE|COMPLEX)/i);
        const openaiConfMatch = openaiResult.match(/CONFIDENCE:\s*([0-9]\.[0-9]+)/i);
        
        if (openaiClassMatch) classification = openaiClassMatch[1].toUpperCase();
        if (openaiConfMatch) confidence = parseFloat(openaiConfMatch[1]);
        break;
        
      case 'anthropic':
        if (!anthropic) {
          console.error(chalk.red('Anthropic API key not set or invalid. Defaulting to complex query routing.'));
          classification = 'COMPLEX';
          confidence = 1.0;
          break;
        }
        const anthropicClassifierResponse = await anthropic.messages.create({
          model: config.lightModels.anthropic,
          system: 'You are a helpful query classifier.',
          messages: [
            { role: 'user', content: classifierPrompt }
          ],
          max_tokens: 100,
          temperature: 0.1,
        });
        
        const anthropicResult = anthropicClassifierResponse.content[0].text;
        // Parse the result
        const anthropicClassMatch = anthropicResult.match(/CLASSIFICATION:\s*(SIMPLE|COMPLEX)/i);
        const anthropicConfMatch = anthropicResult.match(/CONFIDENCE:\s*([0-9]\.[0-9]+)/i);
        
        if (anthropicClassMatch) classification = anthropicClassMatch[1].toUpperCase();
        if (anthropicConfMatch) confidence = parseFloat(anthropicConfMatch[1]);
        break;
        
      case 'google':
        if (!genAI) {
          console.error(chalk.red('Google API key not set or invalid. Defaulting to complex query routing.'));
          classification = 'COMPLEX';
          confidence = 1.0;
          break;
        }
        const googleClassifierModel = genAI.getGenerativeModel({ model: config.lightModels.google });
        const googleClassifierResponse = await googleClassifierModel.generateContent(classifierPrompt);
        
        const googleResult = googleClassifierResponse.response.text();
        // Parse the result
        const googleClassMatch = googleResult.match(/CLASSIFICATION:\s*(SIMPLE|COMPLEX)/i);
        const googleConfMatch = googleResult.match(/CONFIDENCE:\s*([0-9]\.[0-9]+)/i);
        
        if (googleClassMatch) classification = googleClassMatch[1].toUpperCase();
        if (googleConfMatch) confidence = parseFloat(googleConfMatch[1]);
        break;
        
      case 'openrouter':
        if (!openRouter) {
          console.error(chalk.red('OpenRouter API key not set or invalid. Defaulting to complex query routing.'));
          classification = 'COMPLEX';
          confidence = 1.0;
          break;
        }
        const openRouterClassifierResponse = await openRouter.chat.completions.create({
          model: config.lightModels.openrouter,
          system: 'You are a helpful query classifier.',
          messages: [
            { role: 'user', content: classifierPrompt }
          ],
          temperature: 0.1,
        });
        
        const openRouterResult = openRouterClassifierResponse.choices[0].message.content;
        // Parse the result
        const openRouterClassMatch = openRouterResult.match(/CLASSIFICATION:\s*(SIMPLE|COMPLEX)/i);
        const openRouterConfMatch = openRouterResult.match(/CONFIDENCE:\s*([0-9]\.[0-9]+)/i);
        
        if (openRouterClassMatch) classification = openRouterClassMatch[1].toUpperCase();
        if (openRouterConfMatch) confidence = parseFloat(openRouterConfMatch[1]);
        break;
    }
    
    return {
      isComplex: classification === 'COMPLEX',
      confidence: confidence
    };
    
  } catch (error) {
    console.error(chalk.red('Error classifying query:'), error.message);
    // Default to treating it as complex if there's an error
    return { isComplex: true, confidence: 1.0 };
  }
}

// Ask the AI a question based on current provider
async function askAI(question, options = {}) {
  const silent = !!options.silent;
  // Explicit per-query agentic trigger: \a, \agent, or \agentic
  let agenticRequested = false;
  const prefixMatch = (question || '').match(/^\\(a|agent|agentic)\b\s*/i);
  if (prefixMatch) {
    agenticRequested = true;
    question = question.slice(prefixMatch[0].length).trim();
  }

  // First, attempt a local non-destructive project scan for direct answers
  if (!question.startsWith('\\') && !question.startsWith('/') && !agenticRequested) {
    const localAnswer = await tryLocalProjectAnswer(question, { silent });
    if (localAnswer) {
      // Record and return immediately
      messageHistory.push({ role: 'assistant', content: localAnswer });
      return localAnswer;
    }
  }
  // Check if agentic mode should process this query
  if (config.agentic && 
      !question.startsWith('/') && !activeTaskId && (agenticRequested || (config.agentic.enabled && config.agentic.autoDetect && await shouldUseAgentic(question)))) {
    
    // Initialize task manager if needed
    if (!taskManager) {
      taskManager = new AgentTaskManager();
      
      // Set up event handlers for task manager
      taskManager.on('task-planned', (task) => {
        if (!silent) console.log(chalk.green(`✓ Task planned with ${task.plan.agentCount} agents`));
      });
      
      taskManager.on('task-executing', (task) => {
        if (!silent) console.log(chalk.green(`✓ Executing with ${task.agents.length} agents in parallel`));
      });
      
      taskManager.on('agent-progress', (data) => {
        if (!silent) console.log(chalk.blue(`Agent ${data.agent.role}: Completed action "${data.action}"`));
      });
      
      taskManager.on('task-completed', (result) => {
        if (!silent) console.log(chalk.green('Task completed!'));
        
        // If there's a summary, add it to message history
        if (result.summary) {
          messageHistory.push({ 
            role: 'assistant', 
            content: result.summary 
          });
          
          if (!silent) console.log(formatAIResponse(result.summary));
        }
        
        // Reset active task ID
        activeTaskId = null;
      });
      
      taskManager.on('task-error', (task) => {
        if (!silent) console.log(chalk.red(`Task error: ${task.error}`));
        activeTaskId = null;
      });
    }
    
    const spinner = silent ? null : ora('Processing with agentic mode...').start();
    try {
      // Create a new task with the default conductor setting
      activeTaskId = await taskManager.createTask(question, config.agentic.usePowerfulConductor);
      if (spinner) spinner.succeed(chalk.green(`Parallel processing started`));
      
      // Return placeholder - actual results will come from task completion events
      return "Processing your request with multiple AI agents in parallel...";
    } catch (error) {
      if (spinner) spinner.fail(chalk.red(`Error in agentic processing: ${error.message}`));
      if (!silent) console.log(chalk.yellow('Falling back to standard AI processing.'));
      // Continue with normal processing if agentic fails
    }
  }
  
  // Normal processing continues here
  try {
    const spinner = silent ? null : ora('Thinking...').start();
    let response = '';
    
    // Add question to history
    messageHistory.push({ role: 'user', content: question });
    
    // Limit history to the configured max context window based on active mode
    let maxMessages = config.maxContextMessages;
    if (config.codingMode.enabled) {
      maxMessages = config.codingMode.maxContextMessages;
    } else if (config.fastAnswersMode.enabled) {
      maxMessages = config.fastAnswersMode.maxContextMessages;
    } else if (config.nvimHelpMode.enabled) {
      maxMessages = config.nvimHelpMode.maxContextMessages;
    } else if (config.vocabMode.enabled) {
      maxMessages = config.vocabMode.maxContextMessages;
    }
    
    if (messageHistory.length > maxMessages * 2) {
      // If we have project context or previous conversation messages, preserve them
      const systemMessages = messageHistory.filter(msg => 
        msg.role === 'system' && 
        (msg.content.startsWith('PROJECT CONTEXT:') || msg.content.startsWith('PREVIOUS CONVERSATION CONTEXT:'))
      );
      
      // Keep system messages + the most recent messages
      const recentMessages = messageHistory
        .filter(msg => msg.role !== 'system' || 
          (!msg.content.startsWith('PROJECT CONTEXT:') && !msg.content.startsWith('PREVIOUS CONVERSATION CONTEXT:')))
        .slice(-(maxMessages * 2 - systemMessages.length));
        
      messageHistory = [...systemMessages, ...recentMessages];
    }
    
    // Build system instructions including agent capabilities if enabled
    const agentInstructions = config.agent.enabled ? 
      `You can suggest file system or terminal operations by using {{agent:fs:operation:path[:content]}} or {{agent:exec:command}} syntax. The user will be asked for permission before executing any command. File operations include: read, write, list, exists.
      Examples:
      - To read a file: {{agent:fs:read:/path/to/file.txt}}
      - To list directory contents: {{agent:fs:list:/path/to/directory}}
      - To check if file exists: {{agent:fs:exists:/path/to/file.txt}}
      - To write to a file: {{agent:fs:write:/path/to/file.txt:Content to write}}
      - To run a terminal command: {{agent:exec:ls -la}}
      ` : '';
    
    // Build special mode instructions
    let specialModeInstructions = '';
    
    if (config.fastAnswersMode.enabled) {
      specialModeInstructions = `FAST ANSWERS MODE: Provide concise, direct answers. No explanations, no reasoning steps, no verbose responses. Answer in 1-2 sentences maximum. Focus on the specific question asked.`;
    } else if (config.nvimHelpMode.enabled) {
      // Load nvim keybindings and packages if available
      let nvimContext = '';
      try {
        const keybindings = JSON.parse(fs.readFileSync(path.join(installDir, config.nvimHelpMode.keybindingsFile), 'utf8'));
        const packages = JSON.parse(fs.readFileSync(path.join(installDir, config.nvimHelpMode.packagesFile), 'utf8'));
        nvimContext = `NVIM KEYBINDINGS:\n${JSON.stringify(keybindings, null, 2)}\n\nNVIM PACKAGES:\n${JSON.stringify(packages, null, 2)}`;
      } catch (e) {
        nvimContext = 'Nvim configuration files not found. Using default vim/neovim knowledge.';
      }
      specialModeInstructions = `NVIM HELP MODE: You are a lightning-fast vim/neovim assistant. Provide exact keybindings and commands. Be concise and specific.\n\n${nvimContext}`;
    } else if (config.vocabMode.enabled) {
      specialModeInstructions = `VOCABULARY MODE: You are a writing assistant focused on ${config.vocabMode.focusAreas.join(', ')}. Help fix spelling, improve vocabulary, enhance grammar, make writing more professional, and convert bullet points to polished content. Be concise and direct.`;
    }
    
    // Determine if we should use lightweight model based on special modes and agent mode
    let useMainModel = true;
    let modelDecision = "Using main model";
    let isDirectCmd = false;
    let skipReasoning = false;
    
    // Handle special modes first
    if (config.fastAnswersMode.enabled) {
      useMainModel = !config.fastAnswersMode.useLightModel;
      skipReasoning = config.fastAnswersMode.disableReasoning;
      modelDecision = useMainModel ? "Using main model (fast answers)" : "Using lightweight model (fast answers)";
    } else if (config.nvimHelpMode.enabled) {
      useMainModel = false; // Always use light model for quick nvim help
      skipReasoning = true;
      modelDecision = "Using lightweight model (nvim help)";
    } else if (config.vocabMode.enabled) {
      useMainModel = false; // Use light model for vocab corrections
      skipReasoning = true;
      modelDecision = "Using lightweight model (vocabulary mode)";
    }
    // Check if direct mode is enabled
    else if (config.directMode && config.directMode.enabled) {
      useMainModel = true;
      modelDecision = "Using main model (direct mode enabled)";
      skipReasoning = config.directMode.skipReasoning;
    }
    // If not in direct mode, use agent mode if enabled
    else if (config.agentMode.enabled) {
      if (spinner) spinner.text = 'Analyzing query...';
      
      // Analyze query complexity
      const analysis = await analyzeQueryComplexity(question);
      
      // Check if this is a direct command (file/directory operation)
      if (analysis.isDirectCommand) {
        useMainModel = false;
        isDirectCmd = true;
        skipReasoning = true;
        modelDecision = `Using lightweight model for direct command (confidence: ${analysis.confidence.toFixed(2)})`;
      }
      // Decide whether to use lightweight model based on complexity and confidence
      else if (!analysis.isComplex && analysis.confidence >= config.agentMode.routingThreshold) {
        useMainModel = false;
        skipReasoning = true;
        modelDecision = `Using lightweight model (confidence: ${analysis.confidence.toFixed(2)})`;
      } else if (analysis.isComplex && analysis.confidence >= config.agentMode.routingThreshold) {
        useMainModel = true;
        modelDecision = `Using powerful model for complex query (confidence: ${analysis.confidence.toFixed(2)})`;
      } else {
        // If confidence is low, default to powerful model
        useMainModel = true;
        modelDecision = `Defaulting to powerful model (low classification confidence: ${analysis.confidence.toFixed(2)})`;
      }
      
      if (spinner) spinner.text = 'Thinking...';
    }
    
    // Create a context-aware history format for each provider
    switch (config.currentProvider) {
      case 'openai':
        const openaiMessages = [
          {
            role: 'system',
            content: `You are a helpful AI assistant in a terminal environment. ${specialModeInstructions ? specialModeInstructions + ' ' : ''}${isDirectCmd ? 
              `For file and terminal operations, ALWAYS use the most direct approach. When asked to list files or show directory contents, use the {{agent:exec:ls -la /path}} or {{agent:fs:list:/path}} syntax immediately without unnecessary explanation. Be concise and action-oriented.` : 
              ''} ${agentInstructions}`
          },
          ...messageHistory.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          }))
        ];
        
        const model = useMainModel ? config.models.openai : config.lightModels.openai;
        
        const openaiResponse = await openai.chat.completions.create({
          model: model,
          messages: openaiMessages,
          ...(!(model && typeof model === 'string' && model.startsWith('gpt-5')) ? { temperature: 0.7 } : {}),
        });
        
        response = openaiResponse.choices[0].message.content;
        break;
        
      case 'anthropic':
        if (!anthropic) {
          throw new Error('Anthropic API key not set or invalid. Please check your ANTHROPIC_API_KEY environment variable.');
        }
        // Format messages for Anthropic
        const anthropicSystemContent = `You are a helpful AI assistant in a terminal environment. ${specialModeInstructions ? specialModeInstructions + ' ' : ''}${isDirectCmd ? 
          `For file and terminal operations, ALWAYS use the most direct approach. When asked to list files or show directory contents, use the {{agent:exec:ls -la /path}} or {{agent:fs:list:/path}} syntax immediately without unnecessary explanation. Be concise and action-oriented.` : 
          ''} ${agentInstructions}`;
        
        const anthropicMessages = messageHistory
          .filter(msg => msg.role !== 'system')
          .map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          }));
        
        const anthropicModel = useMainModel ? config.models.anthropic : config.lightModels.anthropic;
        
        const anthropicResponse = await anthropic.messages.create({
          model: anthropicModel,
          system: anthropicSystemContent,
          messages: anthropicMessages,
          max_tokens: 1024,
          temperature: 0.7,
        });
        
        response = anthropicResponse.content[0].text;
        break;
        
      case 'google':
        if (!genAI) {
          throw new Error('Google API key not set or invalid. Please check your GOOGLE_API_KEY environment variable.');
        }
        // Format messages for Google
        const systemPrompt = `You are a helpful AI assistant in a terminal environment. ${specialModeInstructions ? specialModeInstructions + ' ' : ''}${isDirectCmd ? 
          `For file and terminal operations, ALWAYS use the most direct approach. When asked to list files or show directory contents, use the {{agent:exec:ls -la /path}} or {{agent:fs:list:/path}} syntax immediately without unnecessary explanation. Be concise and action-oriented.` : 
          ''} ${agentInstructions}\n\n`;
        
        const googleMessages = [
          systemPrompt,
          ...messageHistory.map(msg => 
            `${msg.role === 'user' ? 'User: ' : 'Assistant: '}${msg.content}`
          )
        ].join('\n\n');
        
        const googleModelName = useMainModel ? config.models.google : config.lightModels.google;
        const googleModel = genAI.getGenerativeModel({ model: googleModelName });
        const googleResponse = await googleModel.generateContent(googleMessages);
        
        response = googleResponse.response.text();
        break;
        
      case 'openrouter':
        if (!openRouter) {
          throw new Error('OpenRouter API key not set or invalid. Please check your OPENROUTER_API_KEY environment variable.');
        }
        
        // Format messages for OpenRouter (uses OpenAI-compatible format)
        const openRouterMessages = [
          {
            role: 'system',
            content: `You are a helpful AI assistant in a terminal environment. ${specialModeInstructions ? specialModeInstructions + ' ' : ''}${isDirectCmd ? 
              `For file and terminal operations, ALWAYS use the most direct approach. When asked to list files or show directory contents, use the {{agent:exec:ls -la /path}} or {{agent:fs:list:/path}} syntax immediately without unnecessary explanation. Be concise and action-oriented.` : 
              ''} ${agentInstructions}`
          },
          ...messageHistory.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          }))
        ];
        
        const openRouterModel = useMainModel ? config.models.openrouter : config.lightModels.openrouter;
        
        const openRouterResponse = await openRouter.chat.completions.create({
          model: openRouterModel,
          messages: openRouterMessages,
          temperature: 0.7,
        });
        
        response = openRouterResponse.choices[0].message.content;
        break;
        
      default:
        throw new Error('Unknown provider');
    }
    
    // If agent mode is enabled, log which model was used
    if (config.agentMode.enabled) {
      if (!silent) console.log(chalk.gray(modelDecision));
    }
    
    // Apply reasoning mode if enabled and query is complex enough and not a direct command
    if (config.reasoningMode.enabled && 
        !skipReasoning &&
        (!config.agentMode.enabled || (config.agentMode.enabled && useMainModel))) {
      
      // Get appropriate messages for the model
      let modelMessages;
      switch (config.currentProvider) {
        case 'openai':
          modelMessages = [
            {
              role: 'system',
              content: `You are a helpful AI assistant in a terminal environment. ${specialModeInstructions ? specialModeInstructions + ' ' : ''}${agentInstructions}`
            },
            ...messageHistory.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            }))
          ];
          break;
          
        case 'anthropic':
          modelMessages = [
            {
              role: 'system',
              content: `You are a helpful AI assistant in a terminal environment. ${specialModeInstructions ? specialModeInstructions + ' ' : ''}${agentInstructions}`
            },
            ...messageHistory.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            }))
          ];
          break;
          
        case 'google':
          // For Google, we'll handle it in the applyReasoningIterations function
          modelMessages = [
            {
              role: 'system',
              content: `You are a helpful AI assistant in a terminal environment. ${specialModeInstructions ? specialModeInstructions + ' ' : ''}${agentInstructions}`
            },
            ...messageHistory.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            }))
          ];
          break;
          
        case 'openrouter':
          modelMessages = [
            {
              role: 'system',
              content: `You are a helpful AI assistant in a terminal environment. ${specialModeInstructions ? specialModeInstructions + ' ' : ''}${agentInstructions}`
            },
            ...messageHistory.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            }))
          ];
          break;
      }
      
      if (spinner) spinner.text = 'Applying reasoning steps...';
      
      // Get the model to use
      const modelToUse = useMainModel ? 
        config.models[config.currentProvider] : 
        config.lightModels[config.currentProvider];
      
      // Apply reasoning steps
      const reasoningResult = await applyReasoningIterations(
        question, 
        modelMessages, 
        config.currentProvider,
        modelToUse
      );
      
      // Show intermediate reasoning steps if enabled
      if (config.reasoningMode.showIntermediate && reasoningResult.intermediateResponses.length > 0) {
        if (spinner) spinner.succeed(chalk.blue('Reasoning complete!'));
        
        console.log(chalk.cyan('\n--- Reasoning Process ---'));
        reasoningResult.intermediateResponses.forEach((step, index) => {
          console.log(chalk.yellow(`\n--- Step ${index + 1} ---`));
          console.log(boxen(step, {
            padding: 1,
            margin: 1,
            borderStyle: 'round',
            borderColor: 'yellow',
            backgroundColor: '#333'
          }));
        });
        console.log(chalk.cyan('--- Final Response ---\n'));
      }
      
      // Update the response with the reasoned answer
      response = reasoningResult.finalResponse;
      
      if (spinner) spinner.text = 'Thinking...';
    }
    
    // Check if AI response contains agent commands (either {{agent:...}} or (Executed: ...))
    const agentCommandRegex = /(\{\{agent:(fs|exec):(.+?)\}\}|\(Executed: (.+?)\))/g;
    let hasAgentCommands = response.match(agentCommandRegex);
    
    if (hasAgentCommands && config.agent.enabled) {
      // Add response to history temporarily
      messageHistory.push({ role: 'assistant', content: response });
      
      if (spinner) spinner.succeed(chalk.blue('Response received!'));
      
      // Display the response with the command suggestion
      if (!silent) console.log(formatAIResponse(response));
      
      // In silent mode (e.g., visual), do not prompt or execute; let caller handle safe ops
      if (silent) {
        return response;
      }
      
      let modifiedResponse = response;
      
      // Find all agent commands in the response
      const commands = [];
      let match;
      
      // This regex captures both {{agent:type:cmd}} format and (Executed: cmd) format
      const singleCommandRegex = /(?:\{\{agent:(fs|exec):(.+?)\}\}|\(Executed: (.+?)\))/g;
      
      while ((match = singleCommandRegex.exec(response)) !== null) {
        // Check which format was matched
        if (match[0].startsWith('{{agent:')) {
          // {{agent:type:cmd}} format
          commands.push({
            fullMatch: match[0],
            commandType: match[1],
            command: match[2]
          });
        } else {
          // (Executed: cmd) format
          // Determine if it's a filesystem or exec command based on command content
          const cmd = match[3];
          const commandType = cmd.startsWith('mkdir') || cmd.startsWith('rm ') || 
                               cmd.startsWith('cp ') || cmd.startsWith('mv ') ||
                               cmd.includes(':') ? 'fs' : 'exec';
          
          commands.push({
            fullMatch: match[0],
            commandType: commandType,
            command: cmd
          });
        }
      }
      
      // Process each command one by one
      for (const cmd of commands) {
        // Determine if we should auto-approve exec
        let confirmed = true;
        if (cmd.commandType === 'fs') {
          // Auto-approve safe FS operations
          const parts = cmd.command.split(':');
          const operation = (parts[0] || '').trim().toLowerCase();
          const safeFs = ['read','list','exists'];
          if (!(config.agent.autoApproveFsSafe && safeFs.includes(operation))) {
            const ans = await inquirer.prompt([{
              type: 'confirm',
              name: 'confirmed',
              message: `AI wants to access file: ${cmd.command}\nAllow this operation?`,
              default: false
            }]);
            confirmed = ans.confirmed;
          }
        } else if (!(cmd.commandType === 'exec' && config.agent.autoApproveExec && !isDangerousExec(cmd.command))) {
          const ans = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirmed',
            message: `AI wants to ${cmd.commandType === 'fs' ? 'access file' : 'run command'}: ${cmd.command}\nAllow this operation?`,
            default: false
          }]);
          confirmed = ans.confirmed;
        }

        if (confirmed) {
          if (cmd.commandType === 'fs') {
            // Use the existing file system command handler
            const parts = cmd.command.split(':');
            const operation = parts[0].trim();
            const filePath = parts[1].trim();
            const content = parts.length > 2 ? parts.slice(2).join(':').trim() : '';
            
            const result = await handleFileOperation(operation, { 
              path: filePath, 
              content: content 
            });
            
            // Display result
            if (result.success) {
              if (result.data) {
                if (typeof result.data === 'boolean') {
                  console.log(chalk.green(`File ${filePath} exists: ${result.data}`));
                } else if (Array.isArray(result.data)) {
                  console.log(chalk.green(`Directory contents of ${filePath}:`));
                  result.data.forEach(item => console.log(`  ${item}`));
                } else {
                  // File content
                  console.log(chalk.green(`Content of ${filePath}:`));
                  console.log(boxen(result.data, {
                    padding: 1,
                    margin: 1,
                    borderStyle: 'round',
                    borderColor: 'green'
                  }));
                }
              } else if (result.message) {
                console.log(chalk.green(result.message));
              }
            } else {
              console.log(chalk.red(`Error: ${result.error}`));
            }
          } else {
            // Execute terminal command directly (handle persistent cd)
            try {
              const raw = cmd.command.trim();
              if (/^cd\s+/i.test(raw)) {
                let target = raw.replace(/^cd\s+/i, '').trim();
                if (target === '~') target = os.homedir();
                if (target.startsWith('~/')) target = path.join(os.homedir(), target.slice(2));
                if (!path.isAbsolute(target)) target = path.resolve(currentWorkingDirectory, target);
                if (!fs.existsSync(target)) {
                  try { fs.mkdirSync(target, { recursive: true }); } catch (e) { throw new Error(`Failed to create directory: ${e.message}`); }
                }
                currentWorkingDirectory = target;
                console.log(chalk.green(`Changed directory to: ${currentWorkingDirectory}`));
              } else {
                // Check if virtual environment is enabled
                const cmdPrefix = config.agent.useVirtualEnvironment ? 'docker run --rm alpine ' : '';
                
                console.log(chalk.blue('Executing command...'));
                // Execute the command
                const result = await executeCommand(cmdPrefix + cmd.command);
                
                // Display result
                console.log(chalk.green('Command output:'));
                console.log(boxen(result.stdout || 'Command executed successfully with no output.', {
                  padding: 1,
                  margin: 1,
                  borderStyle: 'round',
                  borderColor: 'green'
                }));
                
                if (result.stderr) {
                  console.log(chalk.yellow('Command error output:'));
                  console.log(boxen(result.stderr, {
                    padding: 1,
                    margin: 1,
                    borderStyle: 'round',
                    borderColor: 'yellow'
                  }));
                }
              }
            } catch (error) {
              console.log(chalk.red(`Error executing command: ${error.message}`));
            }
          }
          
          // Replace this command with execution note
          modifiedResponse = modifiedResponse.replace(cmd.fullMatch, `(Executed: ${cmd.command})`);
        } else {
          // Replace this command with rejection note
          modifiedResponse = modifiedResponse.replace(cmd.fullMatch, `(Command not executed: ${cmd.command})`);
          console.log(chalk.red('Operation declined.'));
        }
      }
      
      // Update message history with modified response
      messageHistory[messageHistory.length - 1].content = modifiedResponse;
      
      return response;
    } else {
      // Add response to history (no agent commands)
      messageHistory.push({ role: 'assistant', content: response });
      
      spinner.succeed(chalk.blue('Response received!'));
      return response;
    }
    
  } catch (error) {
    console.error(chalk.red('Error getting AI response:'), error.message);
    return 'Sorry, I encountered an error while processing your request.';
  }
}

// Configure provider and model settings
async function configureSettings() {
  while (true) {  // Loop until user chooses to exit
    // Main menu
    const mainMenuChoice = await inquirer.prompt([
      {
        type: 'list',
        name: 'section',
        message: 'Settings Menu - Select a category to configure:',
        choices: [
          'Provider and Model Settings',
          'Conversation Context Settings',
          'Coding Mode Settings',
          'Agent Mode Settings',
          'Reasoning Mode Settings',
          'Agentic Mode Settings',
          'Automatic Local Scan Settings',
          'File/Terminal Agent Settings',
          'Save and Exit'
        ]
      }
    ]);

    // Exit the loop if user chooses to save and exit
    if (mainMenuChoice.section === 'Save and Exit') {
      saveConfig();
      console.log(chalk.green('✓ Configuration saved successfully'));
      break;
    }

    // Handle the selected section
    switch (mainMenuChoice.section) {
      case 'Provider and Model Settings':
        await configureProviderAndModel();
        break;
      case 'Conversation Context Settings':
        await configureContextSettings();
        break;
      case 'Coding Mode Settings':
        await configureCodingMode();
        break;
      case 'Agent Mode Settings':
        await configureAgentMode();
        break;
      case 'Reasoning Mode Settings':
        await configureReasoningMode();
        break;
      case 'Agentic Mode Settings':
        await configureAgenticMode();
        break;
      case 'Automatic Local Scan Settings':
        await configureAutoActions();
        break;
      case 'File/Terminal Agent Settings':
        await configureFileTerminalAgent();
        break;
    }
    
    // Ask if user wants to return to main menu or exit
    const continueChoice = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do next?',
        choices: ['Return to Main Menu', 'Save and Exit']
      }
    ]);
    
    if (continueChoice.action === 'Save and Exit') {
      saveConfig();
      console.log(chalk.green('✓ Configuration saved successfully'));
      break;
    }
  }
}

// Functions for coding mode
function initializeCodingMode() {
  if (!quietStart) console.log(chalk.blue(`Initializing coding mode in ${__dirname}`));
  
  // Set up project context file (ai.md)
  const projectContextPath = path.join(__dirname, config.codingMode.projectContextFile);
  if (!fs.existsSync(projectContextPath)) {
    try {
      fs.writeFileSync(projectContextPath, `# Project Context for ${path.basename(__dirname)}\n\n` +
        `## Overview\n\nThis file contains important project information for AI assistance.\n\n` +
        `## Features\n\n` +
        `## Code Style and Conventions\n\n` +
        `## Important Files\n\n` +
        `## Dependencies\n\n` +
        `## Configuration\n\n` +
        `## Notes\n\n`);
      console.log(chalk.green(`✓ Created project context file at ${projectContextPath}`));
    } catch (error) {
      console.error(chalk.red(`Error creating project context file: ${error.message}`));
    }
  } else {
    console.log(chalk.green(`✓ Using existing project context file at ${projectContextPath}`));
  }
  
  // Set up current conversation file (current.md)
  const currentContextPath = path.join(__dirname, config.codingMode.currentContextFile);
  if (!fs.existsSync(currentContextPath)) {
    try {
      fs.writeFileSync(currentContextPath, `# Current Conversation\n\n` +
        `Started: ${new Date().toISOString()}\n\n`);
      console.log(chalk.green(`✓ Created current conversation file at ${currentContextPath}`));
    } catch (error) {
      console.error(chalk.red(`Error creating current conversation file: ${error.message}`));
    }
  } else {
    console.log(chalk.green(`✓ Using existing current conversation file at ${currentContextPath}`));
  }
  
  // Load project context into memory
  loadProjectContext();
}

function loadProjectContext() {
  const projectContextPath = path.join(__dirname, config.codingMode.projectContextFile);
  
  try {
    if (fs.existsSync(projectContextPath)) {
      const contextContent = fs.readFileSync(projectContextPath, 'utf8');
      
      // Add project context as a system message at the beginning of message history
      const projectContextMsg = {
        role: 'system',
        content: `PROJECT CONTEXT:\n\n${contextContent}\n\nUse this information to provide better assistance for this project.`
      };
      
      // Remove any existing project context message
      messageHistory = messageHistory.filter(msg => 
        !(msg.role === 'system' && msg.content.startsWith('PROJECT CONTEXT:'))
      );
      
      // Add the project context at the beginning
      messageHistory.unshift(projectContextMsg);
      
      if (!quietStart) console.log(chalk.green(`✓ Loaded project context (${contextContent.length} characters)`));
    }
  } catch (error) {
    console.error(chalk.red(`Error loading project context: ${error.message}`));
  }
  
  // Load current conversation if it exists
  loadCurrentConversation();
}

function loadCurrentConversation() {
  const currentContextPath = path.join(__dirname, config.codingMode.currentContextFile);
  
  try {
    if (fs.existsSync(currentContextPath)) {
      const conversationContent = fs.readFileSync(currentContextPath, 'utf8');
      
      // Only load if there's actual conversation content
      if (conversationContent.length > 50) { // More than just the header
        if (!quietStart) console.log(chalk.green(`✓ Found existing conversation context (${conversationContent.length} characters)`));
        
        // Add a system message indicating this is previously compacted context
        if (messageHistory.find(msg => msg.role === 'system' && msg.content.startsWith('PROJECT CONTEXT:'))) {
          // If we already have a project context, add this after it
          messageHistory.splice(1, 0, {
            role: 'system',
            content: `PREVIOUS CONVERSATION CONTEXT:\n\n${conversationContent}`
          });
        } else {
          // Otherwise add it at the beginning
          messageHistory.unshift({
            role: 'system',
            content: `PREVIOUS CONVERSATION CONTEXT:\n\n${conversationContent}`
          });
        }
      }
    }
  } catch (error) {
    console.error(chalk.red(`Error loading current conversation: ${error.message}`));
  }
}

function updateConversationFile(question, answer) {
  if (!config.codingMode.enabled) return;
  
  const currentContextPath = path.join(__dirname, config.codingMode.currentContextFile);
  
  try {
    // Add the latest Q&A to the conversation file
    let content = '';
    if (fs.existsSync(currentContextPath)) {
      content = fs.readFileSync(currentContextPath, 'utf8');
    }
    
    // Append the new conversation
    content += `\n## User\n${question}\n\n## Assistant\n${answer}\n\n`;
    
    // Write back to file
    fs.writeFileSync(currentContextPath, content);
  } catch (error) {
    console.error(chalk.red(`Error updating conversation file: ${error.message}`));
  }
}

async function compactConversation() {
  if (!config.codingMode.enabled) {
    console.log(chalk.yellow('Compact command is only available in coding mode.'));
    return;
  }
  
  const currentContextPath = path.join(__dirname, config.codingMode.currentContextFile);
  
  if (!fs.existsSync(currentContextPath)) {
    console.log(chalk.yellow('No conversation file found to compact.'));
    return;
  }
  
  try {
    const conversationContent = fs.readFileSync(currentContextPath, 'utf8');
    if (conversationContent.length < 100) {
      console.log(chalk.yellow('Conversation is too short to compact.'));
      return;
    }
    
    console.log(chalk.blue('Compacting conversation...'));
    const spinner = ora('Analyzing conversation...').start();
    
    // Use the current model to summarize the conversation
    const summaryPrompt = `Below is a conversation history. Please create a compact summary that keeps only the most important context, including:
1. Key decisions and information needed for future reference
2. Specific code or config changes discussed
3. Project requirements and constraints mentioned
4. Any unresolved issues or next steps

Format the summary as a well-organized markdown document that a future AI assistant could use to understand the current state of the project. Remove any pleasantries, redundancies, or information that isn't necessary for future context.

CONVERSATION:
${conversationContent}`;

    // Get AI response based on current provider
    let summary = '';
    
    switch (config.currentProvider) {
      case 'openai':
        if (!openai) {
          spinner.fail(chalk.red('OpenAI API key not set or invalid.'));
          return;
        }
        const openaiResponse = await openai.chat.completions.create({
          model: config.models.openai,
          messages: [
            { role: 'system', content: 'You are an expert at summarizing coding conversations, retaining only the essential information needed for future context.' },
            { role: 'user', content: summaryPrompt }
          ],
          ...(!(config.models.openai && typeof config.models.openai === 'string' && config.models.openai.startsWith('gpt-5')) ? { temperature: 0.3 } : {}),
        });
        summary = openaiResponse.choices[0].message.content;
        break;
        
      case 'anthropic':
        if (!anthropic) {
          spinner.fail(chalk.red('Anthropic API key not set or invalid.'));
          return;
        }
        const anthropicResponse = await anthropic.messages.create({
          model: config.models.anthropic,
          messages: [
            { role: 'system', content: 'You are an expert at summarizing coding conversations, retaining only the essential information needed for future context.' },
            { role: 'user', content: summaryPrompt }
          ],
          max_tokens: 4000,
          temperature: 0.3,
        });
        summary = anthropicResponse.content[0].text;
        break;
        
      case 'google':
        if (!genAI) {
          spinner.fail(chalk.red('Google API key not set or invalid.'));
          return;
        }
        const systemPrompt = 'You are an expert at summarizing coding conversations, retaining only the essential information needed for future context.';
        const googleMessages = [systemPrompt, summaryPrompt].join('\n\n');
        const googleModel = genAI.getGenerativeModel({ model: config.models.google });
        const googleResponse = await googleModel.generateContent(googleMessages);
        summary = googleResponse.response.text();
        break;
        
      case 'openrouter':
        if (!openRouter) throw new Error('OpenRouter API key not configured');
        
        const openRouterResponse = await openRouter.chat.completions.create({
          model: conductor.model,
          messages: [
            { role: 'system', content: 'You are an expert at synthesizing information from multiple sources into coherent summaries.' },
            { role: 'user', content: summaryPrompt }
          ],
          temperature: 0.3,
        });
        
        summary = openRouterResponse.choices[0].message.content;
        break;
        
      default:
        spinner.fail(chalk.red('Unknown provider for conversation compaction.'));
        return;
    }
    
    // Write the summary back to the file with a header
    const compactedContent = `# Compacted Conversation History\n\nLast compacted: ${new Date().toISOString()}\n\n${summary}`;
    fs.writeFileSync(currentContextPath, compactedContent);
    
    // Update the last compacted timestamp
    config.codingMode.lastCompacted = Date.now();
    saveConfig();
    
    // Reload the conversation context
    messageHistory = messageHistory.filter(msg => 
      !(msg.role === 'system' && msg.content.startsWith('PREVIOUS CONVERSATION CONTEXT:'))
    );
    loadCurrentConversation();
    
    spinner.succeed(chalk.green(`Conversation compacted! Reduced from ${conversationContent.length} to ${compactedContent.length} characters.`));
    
  } catch (error) {
    console.error(chalk.red(`Error compacting conversation: ${error.message}`));
  }
}

function updateProjectContext(newFeature) {
  if (!config.codingMode.enabled) return;
  
  const projectContextPath = path.join(__dirname, config.codingMode.projectContextFile);
  
  try {
    if (fs.existsSync(projectContextPath)) {
      let contextContent = fs.readFileSync(projectContextPath, 'utf8');
      
      // Add the new feature to the Features section
      if (contextContent.includes('## Features')) {
        const featuresSection = contextContent.split('## Features')[1].split('##')[0];
        if (featuresSection.trim() === '') {
          // If Features section is empty
          contextContent = contextContent.replace('## Features\n\n', `## Features\n\n- ${newFeature}\n\n`);
        } else {
          // If Features section already has content
          contextContent = contextContent.replace('## Features\n\n', `## Features\n\n- ${newFeature}\n`);
        }
      }
      
      // Write updated content back to the file
      fs.writeFileSync(projectContextPath, contextContent);
      
      // Reload the project context
      loadProjectContext();
      
      console.log(chalk.green(`✓ Added new feature to project context: ${newFeature}`));
    }
  } catch (error) {
    console.error(chalk.red(`Error updating project context: ${error.message}`));
  }
}

// Interactive chat mode
async function startChatMode() {
  if (!quietStart) {
    displayLogo();
  }
  
  // Initialize coding mode if enabled
  if (config.codingMode.enabled) {
    initializeCodingMode();
  }
  
  // Check if API key is set for the current provider
  if (config.currentProvider === 'openai' && !process.env.OPENAI_API_KEY) {
    console.log(chalk.red('Error: OPENAI_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('Please set it in your .env file or export it in your shell.'));
    console.log(chalk.yellow('Use the /menu command to switch to a different provider or exit and set the key.'));
  } else if (config.currentProvider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.log(chalk.red('Error: ANTHROPIC_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('Please set it in your .env file or export it in your shell.'));
    console.log(chalk.yellow('Use the /menu command to switch to a different provider or exit and set the key.'));
  } else if (config.currentProvider === 'google' && !process.env.GOOGLE_API_KEY) {
    console.log(chalk.red('Error: GOOGLE_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('Please set it in your .env file or export it in your shell.'));
    console.log(chalk.yellow('Use the /menu command to switch to a different provider or exit and set the key.'));
  } else if (config.currentProvider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    console.log(chalk.red('Error: OPENROUTER_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('Please set it in your .env file or export it in your shell.'));
    console.log(chalk.yellow('Use the /menu command to switch to a different provider or exit and set the key.'));
  }
  
  if (!quietStart) {
    console.log(chalk.cyan(`Current provider: ${chalk.bold(config.currentProvider)}`));
    // Show model info
    console.log(chalk.cyan(`Using model: ${chalk.bold(config.models[config.currentProvider])}`));
  }
  
  // Show current mode status
  if (!quietStart) {
    if (config.smartMode.enabled) {
      console.log(chalk.magenta('Smart Mode: Enabled - Lightweight model coordinates responses'));
      console.log(chalk.cyan(`Coordinator model: ${chalk.bold(config.lightModels[config.currentProvider])}`));
    } else {
      console.log(chalk.magenta('Powerful Mode: Enabled (default) - Powerful model handles all queries'));
    }
  }
  
  // Show reasoning mode status
  if (!quietStart) {
    if (config.directMode.skipReasoning) {
      console.log(chalk.magenta('Fast Mode: Enabled (default) - Reasoning disabled for faster responses'));
    } else if (config.reasoningMode.enabled) {
      console.log(chalk.magenta(`Reasoning: Enabled (${config.reasoningMode.iterations} iterations)`));
    }
  }
  
  // Show special mode status
  if (!quietStart) {
    if (config.fastAnswersMode.enabled) {
      console.log(chalk.cyan('🚀 Fast Answers Mode: Lightning-fast responses for quick questions'));
    } else if (config.nvimHelpMode.enabled) {
      console.log(chalk.cyan('⚡ Nvim Help Mode: Instant vim/neovim keybinding assistance'));
    } else if (config.vocabMode.enabled) {
      console.log(chalk.cyan('📝 Vocabulary Mode: Writing, spelling, and grammar assistance'));
    }
  }
  
  if (!quietStart) {
    console.log(chalk.yellow('Type "/help" for available commands, "/exit", "/quit", or "/end" to quit'));
  }
  
  // Show agent commands if enabled
  if (!quietStart && config.agent.enabled) {
    console.log(chalk.yellow('Agent commands: "/fs" for file operations, "/exec" for terminal commands'));
    console.log(chalk.yellow('Prefix "\\a" to run a single query with agentic multi-agent execution'));
  }
  
  if (!quietStart) {
    console.log(chalk.yellow('Type "\\p" or "\\paste" to enter multiline paste mode'));
    console.log(chalk.yellow('In paste mode, type "\\end" or "/end" on a new line to finish pasting'));
    console.log(chalk.yellow('Use \\ at the end of a line + Enter for multi-line input'));
    console.log(chalk.yellow('Hotkeys: F8 copies last AI response to clipboard'));
  } else {
    console.log(chalk.green('<Connected>'));
  }

  // Enable bracketed paste for robust multiline paste handling
  enableBracketedPaste();
  
  // Show new file operation functionality (quiet in quiet-start)
  if (!quietStart) {
    console.log(chalk.yellow('Auto-file-saving: AI can save files with ```tool_code {{agent:fs:write:file:content}} ``` syntax\n'));
  }
  
  // We've moved these handlers inline to reduce complexity

  // Main chat loop
  while (true) {
    let multilineInput = '';
    let continueInput = true;
    
    // Reset history navigation for new input
    inputHistoryIndex = -1;
    let currentDraft = '';
    
    while (continueInput) {
      const prompt = inquirer.prompt([
        {
          type: 'input',
          name: 'userInput',
          message: chalk.green(`${formatCwdForPrompt()} >`),
          prefix: '',
          // Fix backspace bug by handling raw input properly
          rl: {
            deleteForward: true,
            escapeCodeTimeout: 50,
            // Add a custom refresh line handler to improve cursor positioning with line wrapping
            _refreshLine: function() {
              const line = this.line || '';
              const cursor = this.cursor || 0;
              
              // Clear from cursor to end of line
              this.output.write('\x1b[0K');
              
              // Write the line and position cursor
              this.output.write(line);
              
              // Move cursor to correct position if needed
              if (cursor < line.length) {
                const cursorPos = -(line.length - cursor);
                if (cursorPos) {
                  this.output.write(`\x1b[${cursorPos}D`);
                }
              }
            }
          }
        }
      ]);
      
      // Get the underlying readline interface to handle key events
      const rl = prompt.ui.rl;
      
      // Store current line when up arrow is pressed
      let lineBeforeHistory = '';
      let pastedText = '';
      let isPasting = false;
      let startTime = 0;
      
      // Bracketed paste handling at the tty data level
      let bracketPasting = false;
      let bracketBuffer = '';
      let collectedPaste = null;
      const dataListener = (chunk) => {
        const s = chunk.toString('utf8');
        if (s.includes('\u001b[200~')) {
          bracketPasting = true;
          bracketBuffer += s.replace(/\u001b\[200~/g, '');
          return;
        }
        if (bracketPasting) {
          if (s.includes('\u001b[201~')) {
            bracketBuffer += s.replace(/\u001b\[201~/g, '');
            bracketPasting = false;
            // Capture entire pasted content separately from readline
            collectedPaste = bracketBuffer;
            bracketBuffer = '';
            // Trigger prompt completion
            setImmediate(() => rl.emit('line'));
            return;
          }
          bracketBuffer += s;
          return;
        }
      };
      rl.input.on('data', dataListener);

      // Handle up and down arrow keys for history navigation
      rl.on('line', (line) => {
        // Save the entered line to restore it when navigating history
        if (inputHistoryIndex === -1) {
          currentDraft = line;
        }
      });
      
      rl.on('SIGINT', () => {
        prompt.ui.close();
        process.exit(0);
      });
      
      // Listen for keypress events
      rl.input.on('keypress', (char, key) => {
        if (!key && !char) return;
        
        // Hotkey: F8 copies last AI response to clipboard
        if (key && key.name === 'f8') {
          const content = stripAnsi(lastAIResponse || '');
          copyToClipboard(content).then((res) => {
            if (res.copied) {
              console.log(chalk.green('\n✓ Copied last AI response to clipboard'));
            } else if (res.fallback) {
              console.log(chalk.yellow(`\nSaved last AI response to ${res.fallback}`));
            }
            // Repaint the prompt line after message
            if (prompt.ui.activePrompt && prompt.ui.activePrompt.opt.rl._refreshLine) {
              prompt.ui.activePrompt.opt.rl._refreshLine.call(rl);
            } else {
              rl._refreshLine();
            }
          }).catch(() => {
            console.log(chalk.red('\nFailed to copy to clipboard'));
          });
          return;
        }
        
        // Handle up arrow key - navigate backward in history
        if (key && key.name === 'up') {
          // Save current input if we're just starting to navigate
          if (inputHistoryIndex === -1 && rl.line.length > 0) {
            lineBeforeHistory = rl.line;
          }
          
          // Move back in history if possible
          if (inputHistoryIndex < inputHistory.length - 1) {
            inputHistoryIndex++;
            rl.line = inputHistory[inputHistory.length - 1 - inputHistoryIndex];
            rl.cursor = rl.line.length;
            // Use our custom _refreshLine implementation if available
            if (prompt.ui.activePrompt && prompt.ui.activePrompt.opt.rl._refreshLine) {
              prompt.ui.activePrompt.opt.rl._refreshLine.call(rl);
            } else {
              rl._refreshLine();
            }
          }
        } 
        // Handle down arrow key - navigate forward in history
        else if (key && key.name === 'down') {
          if (inputHistoryIndex > -1) {
            inputHistoryIndex--;
            
            if (inputHistoryIndex === -1) {
              // Restore the draft that was being written
              rl.line = lineBeforeHistory || currentDraft;
            } else {
              rl.line = inputHistory[inputHistory.length - 1 - inputHistoryIndex];
            }
            
            rl.cursor = rl.line.length;
            // Use our custom _refreshLine implementation if available
            if (prompt.ui.activePrompt && prompt.ui.activePrompt.opt.rl._refreshLine) {
              prompt.ui.activePrompt.opt.rl._refreshLine.call(rl);
            } else {
              rl._refreshLine();
            }
          }
        }
      });
      
      // Wait for the prompt to complete
      const { userInput } = await prompt;

      // If we captured a bracketed paste, use it directly
      if (collectedPaste !== null) {
        const lineCount = collectedPaste.split(/\r?\n/).length;
        console.log(chalk.blue(`Captured paste (${lineCount} line${lineCount===1?'':'s'})`));
        multilineInput = collectedPaste;
        continueInput = false;
        // Cleanup listeners before looping
        rl.input.removeAllListeners('keypress');
        rl.input.removeListener('data', dataListener);
        rl.removeAllListeners('line');
        rl.removeAllListeners('SIGINT');
        continue;
      }
      
      // Check for paste command
      if (isPasteMode(userInput.trim())) {
        // User entered paste mode command - switch to enhanced paste mode
        console.log(chalk.blue('Entering paste mode...'));
        const pastedContent = await enhancedPasteMode();
        
        if (pastedContent) {
          const lineCount = pastedContent.split(/\r?\n/).length;
          console.log(chalk.blue(`Captured paste (${lineCount} line${lineCount===1?'':'s'})`));
          // Submit the content from paste mode
          multilineInput = pastedContent;
          continueInput = false;
        }
        continue;
      }
      
      // Check if input ends with backslash to continue to next line
      if (userInput.endsWith('\\')) {
        multilineInput += userInput.slice(0, -1) + '\n';
        continue;
      } 
      // Process regular input - submit immediately unless empty
      else if (userInput !== '') {
        multilineInput = userInput;
        continueInput = false;
      }
      // Empty input - just continue
      else {
        if (multilineInput) {
          // Submit accumulated multiline input on blank line
          continueInput = false;
        } else {
          continue;
        }
      }
      
      // Remove event listeners to prevent duplicates in next iteration
      rl.input.removeAllListeners('keypress');
      rl.input.removeListener('data', dataListener);
      rl.removeAllListeners('line');
      rl.removeAllListeners('SIGINT');
    }
    
    let question = multilineInput.trim();

    // Quick approval: if user typed yes and last assistant message has agent commands or code blocks, execute directly
    const yesRegex = /^(y|yes|yeah|sure|ok|okay|do it|please do it)\.?$/i;
    if (yesRegex.test(question) && messageHistory.length > 0) {
      const last = [...messageHistory].reverse().find(m => m.role === 'assistant');
      if (last) {
        const hasAgent = /(\{\{agent:(fs|exec):(.+?)\}\}|\(Executed: (.+?)\))/.test(last.content);
        const commands = extractShellCommandsFromText(last.content);
        if (hasAgent) {
          console.log(chalk.blue('Approved. Executing requested operation...'));
          await executeAgentCommandsFromText(last.content, { autoCreateCdDir: true });
          continue;
        } else if (commands.length) {
          console.log(chalk.blue(`Approved. Executing ${commands.length} command(s)...`));
          await runShellCommandsSequentially(commands);
          continue;
        }
      }
    }
    
    // Check if this is an automatic multiline paste
    if (isMultilinePaste(question)) {
      const lineCount = question.split(/\r?\n/).length;
      console.log(chalk.blue(`Detected multiline paste - processing directly (${lineCount} line${lineCount===1?'':'s'})...`));
      
      // Strip optional per-query agentic prefix for display/history
      const displayQuestion = question.replace(/^\\(a|agent|agentic)\b\s*/i, '');
      // Add to message history
      messageHistory.push({ role: 'user', content: displayQuestion });
      
      // No explicit user echo; prompt already shows cwd
      
      // Get AI response
      const response = await askAI(question);
      
      // Add to input history
      if (!inputHistory.includes(displayQuestion)) {
        inputHistory.push(displayQuestion);
        
        // Limit history size
        if (inputHistory.length > 50) {
          inputHistory.shift();
        }
      }
      
      // Display response if it doesn't contain agent commands
      if (!response.match(/(\{\{agent:(fs|exec):(.+?)\}\}|\(Executed: (.+?)\))/g)) {
        console.log(formatAIResponse(response));
      }
      
      continue;
    }

    // Map forward-slash commands to backslash equivalents (deprecated alias)
    if (question.startsWith('/') && question.length > 1) {
      if (!warnedAboutSlash) {
        console.log(chalk.yellow('Tip: Use backslash (\\) for commands. "/" is supported but deprecated.'));
        warnedAboutSlash = true;
      }
      question = '\\' + question.slice(1);
    }
    
    // Fast-path intents: start new coding project in <path>
    if (await handleStartNewProjectIntent(question)) {
      // After scaffolding, skip asking AI
      continue;
    }

    // Handle special commands with forward slash
    if (question.toLowerCase() === '/exit' || question.toLowerCase() === '/quit' || question.toLowerCase() === '/end' || question.toLowerCase() === '/q') {
      console.log(chalk.yellow('Goodbye!'));
      break;
    } else if (question.toLowerCase() === '/clear' || question.toLowerCase() === '/c') {
      // Clear context and screen
      messageHistory = [];
      console.clear();
      if (!quietStart) displayLogo();
      
      // In coding mode, clear the current conversation file
      if (config.codingMode.enabled) {
        const currentContextPath = path.join(__dirname, config.codingMode.currentContextFile);
        try {
          fs.writeFileSync(currentContextPath, `# Current Conversation\n\nStarted: ${new Date().toISOString()}\n\n`);
          if (!quietStart) {
            console.log(chalk.yellow('Terminal, context, and conversation file cleared!'));
          } else {
            console.log(chalk.green('<Cleared>'));
          }
        } catch (error) {
          console.error(chalk.red(`Error clearing conversation file: ${error.message}`));
          if (!quietStart) {
            console.log(chalk.yellow('Terminal and context cleared!'));
          } else {
            console.log(chalk.green('<Cleared>'));
          }
        }
      } else {
        if (!quietStart) {
          console.log(chalk.yellow('Terminal and context cleared!'));
        } else {
          console.log(chalk.green('<Cleared>'));
        }
      }
      continue;
    } else if (question.toLowerCase() === '/clearscreen' || question.toLowerCase() === '/cls') {
      // Clear just the screen
      console.clear();
      if (!quietStart) {
        displayLogo();
        console.log(chalk.yellow('Terminal screen cleared!'));
      } else {
        console.log(chalk.green('<Screen Cleared>'));
      }
      continue;
    } else if (question.toLowerCase() === '/copy' || question.toLowerCase() === '/copy-last') {
      // Copy last AI response to clipboard
      const content = stripAnsi(lastAIResponse || '');
      if (!content) {
        console.log(chalk.yellow('No AI response to copy yet.'));
        continue;
      }
      try {
        const res = await copyToClipboard(content);
        if (res.copied) {
          console.log(chalk.green('✓ Copied last AI response to clipboard'));
        } else if (res.fallback) {
          console.log(chalk.yellow(`Clipboard helper unavailable. Saved to ${res.fallback}`));
        }
      } catch (err) {
        console.log(chalk.red('Failed to copy to clipboard')); 
      }
      continue;
    } else if (question.toLowerCase() === '/copy-all' || question.toLowerCase() === '/copy-session') {
      // Copy session transcript
      const all = stripAnsi(sessionTranscript.join('\n'));
      if (!all.trim()) {
        console.log(chalk.yellow('Nothing to copy yet.'));
        continue;
      }
      try {
        const res = await copyToClipboard(all);
        if (res.copied) {
          console.log(chalk.green('✓ Copied session transcript to clipboard'));
        } else if (res.fallback) {
          console.log(chalk.yellow(`Clipboard helper unavailable. Saved to ${res.fallback}`));
        }
      } catch (err) {
        console.log(chalk.red('Failed to copy session to clipboard'));
      }
      continue;
    } else if (question.toLowerCase() === '/compact' || question.toLowerCase() === '/co') {
      // Compact the conversation in coding mode
      await compactConversation();
      continue;
    } else if (question.toLowerCase().startsWith('/feature ') || question.toLowerCase().startsWith('/ft ')) {
      // Add a new feature to the project context
      if (config.codingMode.enabled) {
        const featureDescription = question.toLowerCase().startsWith('/feature ') ? 
          question.slice(9).trim() : question.slice(4).trim();
        if (featureDescription) {
          updateProjectContext(featureDescription);
        } else {
          console.log(chalk.yellow('Please provide a feature description after the /feature command.'));
        }
      } else {
        console.log(chalk.yellow('Feature command is only available in coding mode.'));
      }
      continue;
    } else if (question.toLowerCase() === '/agentic' || question.toLowerCase() === '/schedule') {
      // Toggle agentic mode
      config.agentic.enabled = !config.agentic.enabled;
      
      if (config.agentic.enabled) {
        // Initialize task manager if needed
        if (!taskManager) {
          taskManager = new AgentTaskManager();
          
          // Set up event handlers
          taskManager.on('task-planned', (task) => {
            console.log(chalk.green(`✓ Task planned: ${task.plan.agentCount} agents`));
            console.log(chalk.cyan('Analysis:'), task.plan.analysis);
            console.log(chalk.cyan('Estimated steps:'), task.plan.estimatedSteps);
            console.log(chalk.cyan('Estimated time:'), `${task.plan.estimatedTimeMinutes} minutes`);
            
            console.log(chalk.cyan('\nAgents:'));
            task.plan.agents.forEach(agent => {
              console.log(chalk.yellow(`- ${agent.role} (${agent.type}) - ${agent.actions.length} actions`));
            });
          });
          
          taskManager.on('task-executing', (task) => {
            console.log(chalk.green(`✓ Task execution started with ${task.agents.length} agents`));
          });
          
          taskManager.on('agent-progress', (data) => {
            const { agent, action, actionsRemaining } = data;
            console.log(chalk.blue(`Agent ${agent.role} completed action: ${action}`));
            console.log(chalk.gray(`${actionsRemaining} actions remaining`));
          });
          
          taskManager.on('agent-needs-permission', (agent) => {
            console.log(chalk.yellow(`\nAgent ${agent.role} needs permission to continue.`));
            console.log(chalk.yellow('Type "/continue" to allow the agent to perform more actions.'));
          });
          
          taskManager.on('agent-completed', (agent) => {
            console.log(chalk.green(`✓ Agent ${agent.role} completed all actions`));
          });
          
          taskManager.on('task-completed', (data) => {
            const { task, summary } = data;
            console.log(chalk.green.bold(`\n✓ Task completed: ${task.description}`));
            
            if (summary) {
              console.log(boxen(summary, {
                padding: 1,
                margin: 1,
                borderStyle: 'round',
                borderColor: 'green',
                backgroundColor: '#222'
              }));
            }
            
            // Reset active task
            activeTaskId = null;
          });
          
          taskManager.on('task-error', (task) => {
            console.log(chalk.red(`\n✗ Task error: ${task.error}`));
            
            // Reset active task
            activeTaskId = null;
          });
        }
        
        console.log(chalk.green(`✓ Agentic mode enabled`));
        console.log(chalk.yellow('Enter a task description or use "/task <description>" to start a new task.'));
        console.log(chalk.yellow('Use "\\smart-conductor" to enable a powerful model as the task conductor.'));
      } else {
        console.log(chalk.yellow('Agentic mode disabled.'));
      }
      continue;
    } else if (question.toLowerCase() === '\\fast-answers' || question.toLowerCase() === '\\fa') {
      // Toggle fast answers mode
      config.fastAnswersMode.enabled = !config.fastAnswersMode.enabled;
      if (config.fastAnswersMode.enabled) {
        // Disable other modes when enabling fast answers
        config.reasoningMode.enabled = false;
        config.agentMode.enabled = false;
        config.agentic.enabled = false;
        config.codingMode.enabled = false;
        config.nvimHelpMode.enabled = false;
        config.vocabMode.enabled = false;
        console.log(chalk.green('🚀 Fast Answers Mode enabled - Lightning-fast responses for quick questions'));
      } else {
        console.log(chalk.yellow('Fast Answers Mode disabled.'));
      }
      continue;
    } else if (question.toLowerCase() === '\\nvim-help' || question.toLowerCase() === '\\nvim') {
      // Toggle nvim help mode
      config.nvimHelpMode.enabled = !config.nvimHelpMode.enabled;
      if (config.nvimHelpMode.enabled) {
        // Disable other modes when enabling nvim help
        config.reasoningMode.enabled = false;
        config.agentMode.enabled = false;
        config.agentic.enabled = false;
        config.codingMode.enabled = false;
        config.fastAnswersMode.enabled = false;
        config.vocabMode.enabled = false;
        console.log(chalk.green('⚡ Nvim Help Mode enabled - Instant vim/neovim keybinding assistance'));
      } else {
        console.log(chalk.yellow('Nvim Help Mode disabled.'));
      }
      continue;
    } else if (question.toLowerCase() === '\\vocabulary' || question.toLowerCase() === '\\vocab') {
      // Toggle vocabulary mode
      config.vocabMode.enabled = !config.vocabMode.enabled;
      if (config.vocabMode.enabled) {
        // Disable other modes when enabling vocabulary mode
        config.reasoningMode.enabled = false;
        config.agentMode.enabled = false;
        config.agentic.enabled = false;
        config.codingMode.enabled = false;
        config.fastAnswersMode.enabled = false;
        config.nvimHelpMode.enabled = false;
        console.log(chalk.green('📝 Vocabulary Mode enabled - Writing, spelling, and grammar assistance'));
      } else {
        console.log(chalk.yellow('Vocabulary Mode disabled.'));
      }
      continue;
    } else if (question.toLowerCase().startsWith('\\task ')) {
      // Create a new task
      if (!config.agentic.enabled) {
        console.log(chalk.yellow('Agentic mode is not enabled. Use "\\agentic" to enable it.'));
        continue;
      }
      
      const taskDescription = question.slice(6).trim();
      if (!taskDescription) {
        console.log(chalk.yellow('Please provide a task description.'));
        continue;
      }
      
      const spinner = ora('Creating task...').start();
      try {
        // Create a new task with the default conductor setting
        activeTaskId = await taskManager.createTask(
          taskDescription, 
          config.agentic.usePowerfulConductor
        );
        
        spinner.succeed(chalk.green(`Task created with ID: ${activeTaskId}`));
      } catch (error) {
        spinner.fail(chalk.red(`Error creating task: ${error.message}`));
      }
      
      continue;
    } else if (question.toLowerCase() === '\\smart-conductor') {
      // Toggle powerful conductor
      config.agentic.usePowerfulConductor = !config.agentic.usePowerfulConductor;
      
      console.log(
        config.agentic.usePowerfulConductor ? 
        chalk.green('Powerful conductor enabled for future tasks.') : 
        chalk.yellow('Lightweight conductor enabled for future tasks.')
      );
      continue;
    } else if (question.toLowerCase() === '\\continue') {
      // Continue agent execution
      if (!config.agentic.enabled || !taskManager || !activeTaskId) {
        console.log(chalk.yellow('No active agentic task to continue.'));
        continue;
      }
      
      // Find agents awaiting permission
      const task = taskManager.getTask(activeTaskId);
      if (!task) {
        console.log(chalk.yellow('Active task not found.'));
        continue;
      }
      
      let permissionGranted = false;
      
      for (const agentId of task.agents) {
        const agent = taskManager.getAgent(agentId);
        if (agent && agent.status === 'awaiting-permission') {
          if (taskManager.grantAgentPermission(agentId)) {
            console.log(chalk.green(`Granted permission to agent ${agent.role}.`));
            permissionGranted = true;
          }
        }
      }
      
      if (!permissionGranted) {
        console.log(chalk.yellow('No agents are currently awaiting permission.'));
      }
      
      continue;
    } else if (question.toLowerCase() === '\\cancel-task') {
      // Cancel the current task
      if (!config.agentic.enabled || !taskManager || !activeTaskId) {
        console.log(chalk.yellow('No active agentic task to cancel.'));
        continue;
      }
      
      if (taskManager.cancelTask(activeTaskId)) {
        console.log(chalk.yellow(`Task ${activeTaskId} cancelled.`));
        activeTaskId = null;
      } else {
        console.log(chalk.red(`Failed to cancel task ${activeTaskId}.`));
      }
      
      continue;
    } else if (question.toLowerCase() === '\\status') {
      // Show current task status
      if (!config.agentic.enabled || !taskManager || !activeTaskId) {
        console.log(chalk.yellow('No active agentic task.'));
        continue;
      }
      
      const task = taskManager.getTask(activeTaskId);
      if (!task) {
        console.log(chalk.yellow('Active task not found.'));
        activeTaskId = null;
        continue;
      }
      
      console.log(chalk.cyan(`Task: ${task.description}`));
      console.log(chalk.cyan(`Status: ${task.status}`));
      console.log(chalk.cyan(`Created: ${new Date(task.created).toLocaleString()}`));
      
      if (task.completed) {
        console.log(chalk.cyan(`Completed: ${new Date(task.completed).toLocaleString()}`));
      }
      
      if (task.plan) {
        console.log(chalk.cyan(`Agents: ${task.plan.agentCount} running in parallel`));
        console.log(chalk.cyan(`Execution: ${task.plan.workflow}`));
        
        // Count agents by status
        const agentStats = {
          working: 0,
          completed: 0,
          'awaiting-permission': 0,
          error: 0,
          other: 0
        };
        
        for (const agentId of task.agents) {
          const agent = taskManager.getAgent(agentId);
          if (agent) {
            agentStats[agent.status] = (agentStats[agent.status] || 0) + 1;
            if (!['working', 'completed', 'awaiting-permission', 'error'].includes(agent.status)) {
              agentStats.other++;
            }
          }
        }
        
        console.log(chalk.cyan('\nAgent Summary:'));
        console.log(chalk.green(`- Completed: ${agentStats.completed || 0}`));
        console.log(chalk.blue(`- Working: ${agentStats.working || 0}`));
        console.log(chalk.yellow(`- Awaiting Permission: ${agentStats['awaiting-permission'] || 0}`));
        console.log(chalk.red(`- Error: ${agentStats.error || 0}`));
        
        console.log(chalk.cyan('\nAgent Details:'));
        for (const agentId of task.agents) {
          const agent = taskManager.getAgent(agentId);
          if (agent) {
            let statusColor;
            switch (agent.status) {
              case 'working': statusColor = chalk.blue; break;
              case 'completed': statusColor = chalk.green; break;
              case 'awaiting-permission': statusColor = chalk.yellow; break;
              case 'error': statusColor = chalk.red; break;
              default: statusColor = chalk.white;
            }
            
            console.log(statusColor(`- ${agent.role} (${agent.type}): ${agent.status.toUpperCase()}`));
            console.log(chalk.gray(`  Actions performed: ${agent.actionsPerformed}, Results: ${agent.results.length}, Remaining actions: ${agent.actions.length}`));
            if (agent.results.length > 0 && agent.results[agent.results.length - 1].timestamp) {
              const lastUpdateTime = new Date(agent.results[agent.results.length - 1].timestamp).toLocaleTimeString();
              console.log(chalk.gray(`  Last update: ${lastUpdateTime}`));
            }
          }
        }
      }
      
      continue;
    } else if (question.toLowerCase() === '\\exit' || question.toLowerCase() === '\\quit' || question.toLowerCase() === '\\end' || question.toLowerCase() === '\\q') {
      console.log(chalk.yellow('Goodbye!'));
      break;
    } else if (question.toLowerCase() === '\\clear' || question.toLowerCase() === '\\c') {
      // Clear context and screen
      messageHistory = [];
      console.clear();
      if (!quietStart) displayLogo();
      
      // In coding mode, clear the current conversation file
      if (config.codingMode.enabled) {
        const currentContextPath = path.join(__dirname, config.codingMode.currentContextFile);
        try {
          fs.writeFileSync(currentContextPath, `# Current Conversation\n\nStarted: ${new Date().toISOString()}\n\n`);
          if (!quietStart) {
            console.log(chalk.yellow('Terminal, context, and conversation file cleared!'));
          } else {
            console.log(chalk.green('<Cleared>'));
          }
        } catch (error) {
          console.error(chalk.red(`Error clearing conversation file: ${error.message}`));
          if (!quietStart) {
            console.log(chalk.yellow('Terminal and context cleared!'));
          } else {
            console.log(chalk.green('<Cleared>'));
          }
        }
      } else {
        if (!quietStart) {
          console.log(chalk.yellow('Terminal and context cleared!'));
        } else {
          console.log(chalk.green('<Cleared>'));
        }
      }
      continue;
    } else if (question.toLowerCase() === '\\clearscreen' || question.toLowerCase() === '\\cls') {
      console.clear();
      if (!quietStart) {
        displayLogo();
        console.log(chalk.yellow('Terminal screen cleared!'));
      } else {
        console.log(chalk.green('<Screen Cleared>'));
      }
      continue;
    } else if (question.toLowerCase() === '\\copy' || question.toLowerCase() === '\\copy-last') {
      const content = stripAnsi(lastAIResponse || '');
      if (!content) {
        console.log(chalk.yellow('No AI response to copy yet.'));
        continue;
      }
      try {
        const res = await copyToClipboard(content);
        if (res.copied) {
          console.log(chalk.green('✓ Copied last AI response to clipboard'));
        } else if (res.fallback) {
          console.log(chalk.yellow(`Clipboard helper unavailable. Saved to ${res.fallback}`));
        }
      } catch (err) {
        console.log(chalk.red('Failed to copy to clipboard'));
      }
      continue;
    } else if (question.toLowerCase() === '\\copy-all' || question.toLowerCase() === '\\copy-session') {
      const all = stripAnsi(sessionTranscript.join('\n'));
      if (!all.trim()) {
        console.log(chalk.yellow('Nothing to copy yet.'));
        continue;
      }
      try {
        const res = await copyToClipboard(all);
        if (res.copied) {
          console.log(chalk.green('✓ Copied session transcript to clipboard'));
        } else if (res.fallback) {
          console.log(chalk.yellow(`Clipboard helper unavailable. Saved to ${res.fallback}`));
        }
      } catch (err) {
        console.log(chalk.red('Failed to copy session to clipboard'));
      }
      continue;
    } else if (question.toLowerCase() === '\\compact' || question.toLowerCase() === '\\co') {
      await compactConversation();
      continue;
    } else if (question.toLowerCase().startsWith('\\feature ') || question.toLowerCase().startsWith('\\ft ')) {
      if (config.codingMode.enabled) {
        const featureDescription = question.toLowerCase().startsWith('\\feature ') ? 
          question.slice(9).trim() : question.slice(4).trim();
        if (featureDescription) {
          updateProjectContext(featureDescription);
        } else {
          console.log(chalk.yellow('Please provide a feature description after the \\feature command.'));
        }
      } else {
        console.log(chalk.yellow('Feature command is only available in coding mode.'));
      }
      continue;
    } else if (question.toLowerCase() === '\\help' || question.toLowerCase() === '\\h') {
      // Display help information
      console.log(chalk.cyan('Available Commands:'));
      console.log(chalk.yellow('- \\exit, \\quit, \\end, \\q - Quit the application'));
      console.log(chalk.yellow('- \\clear, \\c - Clear conversation history and terminal screen'));
      console.log(chalk.yellow('- \\cls or \\clearscreen - Clear only the terminal screen'));
      console.log(chalk.yellow('- \\menu, \\m - Access settings menu'));
      console.log(chalk.yellow('- \\help, \\h - Display this help information'));
      console.log(chalk.yellow('- \\d question - Send question directly to the powerful model (bypass routing)'));
      console.log(chalk.yellow('- \\ls [path] - List files in a directory'));
      console.log(chalk.yellow('- \\cat <file> - Print file contents'));
      console.log(chalk.yellow('- \\head [-n N] <file> - Print first N lines of file'));
      console.log(chalk.yellow('- \\tail [-n N] <file> - Print last N lines of file'));
      console.log(chalk.yellow('- \\grep [options] <pattern> <path> - Search files and add summary to AI context'));
      console.log(chalk.yellow('  Options: -r recursive, -i ignore-case, -n line numbers, -F fixed string, --files-only, --ext .js,.ts'));
      console.log(chalk.yellow('- \\copy, \\copy-last - Copy last AI response to clipboard'));
      console.log(chalk.yellow('- \\copy-all, \\copy-session - Copy entire session transcript'));
      console.log(chalk.yellow('- \\direct, \\dr - Toggle direct mode (always use powerful model)'));
      console.log(chalk.yellow('- \\directfast, \\df - Toggle fast direct mode (powerful model with reasoning disabled)'));
      console.log(chalk.yellow('- \\home - Navigate to your home directory'));
      console.log(chalk.yellow('- \\start-project, \\new-project - Start a new coding project'));
      console.log(chalk.yellow('- \\review-project - Analyze the current project directory'));
      console.log(chalk.yellow('- Automatic local scan: Ask “what can you tell me about X in this app?” to run a non-destructive repo scan (toggle in Settings)'));
      console.log(chalk.yellow('- \\auto-scan [on|off] (alias: \\autoscan) - Toggle automatic local scan'));
      console.log(chalk.yellow('- \\visual, \\v - Open visual tri-pane (files | chat | preview). Inside: [V] toggle panes, [C] ask AI'));
      
      console.log(chalk.cyan('\nSpecial Mode Commands:'));
      console.log(chalk.yellow('- \\fast-answers, \\fa - Toggle fast answers mode (quick responses, no reasoning)'));
      console.log(chalk.yellow('- \\nvim-help, \\nvim - Toggle nvim help mode (vim/neovim keybinding assistance)'));
      console.log(chalk.yellow('- \\vocabulary, \\vocab - Toggle vocabulary mode (spelling, grammar, writing help)'));
      
      if (config.codingMode.enabled) {
        console.log(chalk.cyan('\nCoding Mode Commands:'));
        console.log(chalk.yellow('- \\compact, \\co - Summarize the current conversation to preserve context'));
        console.log(chalk.yellow('- \\clear, \\c - Clear conversation history and current.md file'));
        console.log(chalk.yellow('- \\feature <description>, \\ft <description> - Add a new feature to the project context'));
        console.log(chalk.yellow(`- Project context file: ${config.codingMode.projectContextFile}`));
      }
      
      console.log(chalk.cyan('\nAgentic Mode Commands (Multi-threaded Parallel Execution):'));
      console.log(chalk.yellow('- Prefix a query with \\a (or \\agent, \\agentic) to run just that query agentically'));
      console.log(chalk.yellow('- \\agentic or \\schedule - Toggle agentic mode on/off'));
      if (config.agentic.enabled) {
        console.log(chalk.yellow('- \\task <description> - Create a new task with parallel agents'));
        console.log(chalk.yellow('- \\smart-conductor - Toggle using a powerful model as conductor'));
        console.log(chalk.yellow('- \\continue - Grant permission to agents to continue working'));
        console.log(chalk.yellow('- \\cancel-task - Cancel the current task'));
        console.log(chalk.yellow('- \\status - Show current task status and agent progress'));
        
        console.log(chalk.yellow(`- Max parallel agents: ${config.agentic.maxConcurrentAgents} (each runs in a separate thread)`));
        console.log(chalk.yellow(`- Max actions per agent: ${config.agentic.maxActionsPerAgent}`));
        console.log(chalk.yellow(`- Using ${config.agentic.usePowerfulConductor ? 'powerful' : 'lightweight'} conductor`));
      }
      
      if (config.agent.enabled) {
        console.log(chalk.cyan('\nAgent Commands (when enabled):'));
        console.log(chalk.yellow('- \\fs operation:path[:content], \\f operation:path[:content] - File operations'));
        console.log(chalk.yellow('  Operations: read, write, list, exists'));
        console.log(chalk.yellow('- \\exec command, \\e command - Execute terminal commands'));
        console.log(chalk.yellow('- \\terminal, \\t - Toggle direct terminal mode'));
        console.log(chalk.yellow('  In terminal mode, all input is executed as terminal commands'));
        console.log(chalk.yellow('  Directory changes (cd) are tracked across commands'));
      }
      
      if (config.agentMode.enabled) {
        console.log(chalk.cyan('\nAgent Mode:'));
        console.log(chalk.yellow(`- Currently using ${config.models[config.currentProvider]} for complex queries`));
        console.log(chalk.yellow(`- Using ${config.lightModels[config.currentProvider]} for simple queries`));
        console.log(chalk.yellow(`- Classification threshold: ${config.agentMode.routingThreshold}`));
      }
      
      if (config.reasoningMode.enabled) {
        console.log(chalk.cyan('\nReasoning Mode:'));
        console.log(chalk.yellow(`- Enabled with ${config.reasoningMode.iterations} iterations`));
        console.log(chalk.yellow(`- Intermediate steps: ${config.reasoningMode.showIntermediate ? 'Visible' : 'Hidden'}`));
        console.log(chalk.yellow('- Uses iterative self-refinement for complex problems'));
      }
      
      console.log(chalk.cyan('\nInput Methods:'));
      console.log(chalk.yellow('- Use up/down arrows to navigate through input history'));
      console.log(chalk.yellow('- Use \\ at end of line + Enter for multi-line input'));
      console.log(chalk.yellow('- Press Enter on empty line to submit your question'));
      console.log(chalk.yellow('- Type \\p to enter multiline paste mode'));
      console.log(chalk.yellow('- Multiline paste is also detected automatically'));
      console.log(chalk.yellow('- Type \\tui to open the interactive file browser (TUI)'));
      
      console.log(chalk.cyan('\nExamples:'));
      console.log(chalk.yellow('- \\p  (then paste, finish with \\end)'));
      console.log(chalk.yellow('- \\a build a README for this project'));
      continue;
    } else if (question.toLowerCase() === '\\paste' || question.toLowerCase() === '\\p') {
      // Use the enhanced paste mode function for better reliability
      try {
        // Call the global enhancedPasteMode function
        const pastedText = await enhancedPasteMode();
        
        // Process the pasted text if not empty
        if (pastedText && pastedText.trim()) {
          // Add to message history
          messageHistory.push({ role: 'user', content: pastedText.trim() });
          
          // No explicit user echo; prompt already shows cwd
          
          // Get AI response
          const response = await askAI(pastedText.trim());
          
          // Add to input history if it's not a command
          if (!pastedText.trim().startsWith('\\') && !inputHistory.includes(pastedText.trim())) {
            inputHistory.push(pastedText.trim());
            
            // Limit history size
            if (inputHistory.length > 50) {
              inputHistory.shift();
            }
          }
          
          // Display response if it doesn't contain agent commands
          if (!response.match(/(\{\{agent:(fs|exec):(.+?)\}\}|\(Executed: (.+?)\))/g)) {
            console.log(formatAIResponse(response));
          }
        }
      } catch (error) {
        console.log(chalk.red(`Error in paste mode: ${error.message}`));
      }
      
      continue;
    } else if (question.toLowerCase() === '\\menu' || question.toLowerCase() === '\\m') {
      await configureSettings();
      continue;
    } else if (/^\\(auto-scan|autoscan)\b/i.test(question)) {
      const m = question.match(/^\\(auto-scan|autoscan)\b\s*(on|off|enable|disable|true|false)?/i);
      let newVal;
      if (m && m[2]) {
        const opt = m[2].toLowerCase();
        newVal = opt === 'on' || opt === 'enable' || opt === 'true';
      } else {
        newVal = !config.autoActions.localSearchBeforeAI;
      }
      config.autoActions.localSearchBeforeAI = newVal;
      saveConfig();
      console.log(chalk.green(`Automatic local scan is now ${newVal ? 'ENABLED' : 'DISABLED'}.`));
      continue;
    } else if (question.toLowerCase() === '\\tui') {
      console.log(chalk.blue('Launching interactive TUI... (q to quit)'));
      try {
        const res = await startTui(currentWorkingDirectory, { 
          autoScan: config.autoActions?.localSearchBeforeAI,
          onToggleAutoScan: async (v) => {
            config.autoActions.localSearchBeforeAI = !!v;
            saveConfig();
          }
        });
        if (res && res.type === 'askFile' && res.path) {
          try {
            const data = fs.readFileSync(res.path, 'utf8');
            const prompt = `Please review the following file and provide insights, issues, and suggestions.\n\nFile: ${res.path}\n\nContent:\n\n${data}`;
            // No explicit user echo; prompt already shows cwd
            const answer = await askAI(prompt);
            console.log(formatAIResponse(answer));
          } catch (e) {
            console.log(chalk.red(`Failed to read file: ${e.message}`));
          }
        } else if (res && res.type === 'fixFile' && res.path) {
          try {
            const data = fs.readFileSync(res.path, 'utf8');
            const prompt = `You are editing a file. Apply the user's fix instruction to the code and respond ONLY with a tool_code block that writes the full updated file.\n\nInstruction: ${res.instruction}\n\nFile: ${res.path}\n\nCurrent content:\n\n${data}\n\nRespond in this exact format:\n\n\`\`\`tool_code\n{{agent:fs:write:${res.path}:<paste full updated file content here>}}\n\`\`\``;
            // No explicit user echo; prompt already shows cwd
            const answer = await askAI(prompt);
            console.log(formatAIResponse(answer));
          } catch (e) {
            console.log(chalk.red(`Failed to read file: ${e.message}`));
          }
        } else if (res && res.type === 'setCwd' && res.path) {
          changeWorkingDirectory(res.path, false);
        }
      } catch (e) {
        console.log(chalk.red(`TUI error: ${e.message}`));
      }
      continue;
    } else if (question.toLowerCase().startsWith('\\ls')) {
      // Usage: \ls [path]
      const rest = question.slice(3).trim();
      const target = resolveFromCwd(rest || '.');
      try {
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .map(d => d.isDirectory() ? d.name + '/' : d.name)
          .sort((a,b)=>a.localeCompare(b));
        console.log(chalk.cyan(`Listing: ${formatPathForPrint(target)}`));
        console.log(entries.join('\n'));
      } catch (e) {
        console.log(chalk.red(`ls error: ${e.message}`));
      }
      continue;
    } else if (question.toLowerCase().startsWith('\\cat ')) {
      // Usage: \cat <file>
      const rest = question.slice(5).trim();
      const args = tokenizeArgs(rest);
      const filePath = resolveFromCwd(args[0] || '');
      if (!args[0]) { console.log(chalk.yellow('Usage: \\cat <file>')); continue; }
      try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('Not a file');
        const data = safeReadTextFile(filePath, 1024 * 1024);
        console.log(boxen(data, { padding: 0, margin: 0, borderStyle: 'round', borderColor: 'green' }));
      } catch (e) {
        console.log(chalk.red(`cat error: ${e.message}`));
      }
      continue;
    } else if (question.toLowerCase().startsWith('\\head')) {
      // Usage: \head [-n N] <file>
      const rest = question.slice(5).trim();
      const args = tokenizeArgs(rest);
      let n = 10;
      let i = 0;
      if (args[i] && (args[i] === '-n' || args[i] === '--lines')) {
        i++;
        n = parseInt(args[i] || '10', 10) || 10;
        i++;
      }
      const fileArg = args[i];
      if (!fileArg) { console.log(chalk.yellow('Usage: \\head [-n N] <file>')); continue; }
      const filePath = resolveFromCwd(fileArg);
      try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('Not a file');
        const out = headTail(filePath, n, 'head');
        console.log(boxen(out, { padding: 0, margin: 0, borderStyle: 'round', borderColor: 'cyan' }));
      } catch (e) {
        console.log(chalk.red(`head error: ${e.message}`));
      }
      continue;
    } else if (question.toLowerCase().startsWith('\\tail')) {
      // Usage: \tail [-n N] <file>
      const rest = question.slice(5).trim();
      const args = tokenizeArgs(rest);
      let n = 10;
      let i = 0;
      if (args[i] && (args[i] === '-n' || args[i] === '--lines')) {
        i++;
        n = parseInt(args[i] || '10', 10) || 10;
        i++;
      }
      const fileArg = args[i];
      if (!fileArg) { console.log(chalk.yellow('Usage: \\tail [-n N] <file>')); continue; }
      const filePath = resolveFromCwd(fileArg);
      try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('Not a file');
        const out = headTail(filePath, n, 'tail');
        console.log(boxen(out, { padding: 0, margin: 0, borderStyle: 'round', borderColor: 'cyan' }));
      } catch (e) {
        console.log(chalk.red(`tail error: ${e.message}`));
      }
      continue;
    } else if (question.toLowerCase().startsWith('\\grep')) {
      // Usage: \grep [options] <pattern> <path>
      // Options: -r recursive, -i ignore-case, -n line numbers, -F fixed string, --files-only, --ext .js,.ts
      const rest = question.slice(5).trim();
      const args = tokenizeArgs(rest);
      let recursive = false, ignoreCase = false, showLine = false, fixed = false, filesOnly = false;
      let includeExts = null;
      const pos = [];
      for (let j = 0; j < args.length; j++) {
        const a = args[j];
        if (a === '-r' || a === '--recursive') recursive = true;
        else if (a === '-i' || a === '--ignore-case') ignoreCase = true;
        else if (a === '-n' || a === '--line-number') showLine = true;
        else if (a === '-F' || a === '--fixed-strings') fixed = true;
        else if (a === '--files-only' || a === '-l') filesOnly = true;
        else if (a === '--ext' || a === '--include') { includeExts = (args[++j] || '').split(',').map(s=>s.trim().replace(/^\./,'')); }
        else if (a.startsWith('--ext=')) { includeExts = a.slice(6).split(',').map(s=>s.trim().replace(/^\./,'')); }
        else pos.push(a);
      }
      if (pos.length < 2) {
        console.log(chalk.yellow('Usage: \\grep [options] <pattern> <path>'));
        console.log(chalk.yellow('Options: -r, -i, -n, -F, --files-only, --ext .js,.ts'));
        continue;
      }
      const patternRaw = pos[0];
      const searchRoot = resolveFromCwd(pos[1]);
      let matcher;
      try {
        if (fixed) {
          const needle = ignoreCase ? patternRaw.toLowerCase() : patternRaw;
          matcher = (s) => (ignoreCase ? s.toLowerCase() : s).includes(needle);
        } else {
          const re = new RegExp(patternRaw, ignoreCase ? 'i' : '');
          matcher = (s) => re.test(s);
        }
      } catch (e) {
        console.log(chalk.red(`Invalid pattern: ${e.message}`));
        continue;
      }
      const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', 'venv', '__pycache__']);
      const results = [];
      function walk(dir) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (!recursive) continue;
            if (ignoreDirs.has(ent.name)) continue;
            walk(full);
          } else if (ent.isFile()) {
            if (includeExts) {
              const ext = path.extname(ent.name).replace(/^\./,'').toLowerCase();
              if (!includeExts.includes(ext)) continue;
            }
            try {
              const content = fs.readFileSync(full, 'utf8');
              const lines = content.split(/\r?\n/);
              let fileMatches = [];
              for (let li = 0; li < lines.length; li++) {
                const line = lines[li];
                if (matcher(line)) {
                  if (filesOnly) { fileMatches = ['__file_only__']; break; }
                  fileMatches.push({ line: li+1, text: line.length > 400 ? line.slice(0,400) + '…' : line });
                  if (fileMatches.length >= 50) break; // cap per file
                }
              }
              if (fileMatches.length) {
                results.push({ file: full, matches: fileMatches });
              }
            } catch {}
          }
        }
      }
      // Kick off search
      const rootStat = (()=>{ try { return fs.statSync(searchRoot); } catch { return null; }})();
      if (!rootStat) { console.log(chalk.red('Path not found.')); continue; }
      if (rootStat.isDirectory()) walk(searchRoot); else {
        // Single file
        try {
          const content = fs.readFileSync(searchRoot, 'utf8');
          const lines = content.split(/\r?\n/);
          let fileMatches = [];
          for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            if (matcher(line)) {
              if (filesOnly) { fileMatches = ['__file_only__']; break; }
              fileMatches.push({ line: li+1, text: line.length > 400 ? line.slice(0,400) + '…' : line });
              if (fileMatches.length >= 200) break;
            }
          }
          if (fileMatches.length) results.push({ file: searchRoot, matches: fileMatches });
        } catch {}
      }

      // Print results
      if (!results.length) {
        console.log(chalk.yellow('No matches.'));
      } else {
        let totalMatches = 0;
        for (const r of results) {
          if (filesOnly) {
            console.log(chalk.green(formatPathForPrint(r.file)));
          } else {
            console.log(chalk.cyan(`\n${formatPathForPrint(r.file)}`));
            for (const m of r.matches) {
              if (m === '__file_only__') { console.log(chalk.green('(match)')); break; }
              totalMatches++;
              if (showLine) {
                console.log(chalk.gray(`${m.line}: `) + m.text);
              } else {
                console.log(m.text);
              }
              if (totalMatches >= 500) break;
            }
            if (totalMatches >= 500) break;
          }
        }

        // Add condensed summary to AI context
        try {
          const summaryLines = [];
          const maxFilesForContext = Math.min(results.length, 10);
          summaryLines.push(`Search results for pattern "${patternRaw}" in ${formatPathForPrint(searchRoot)}:`);
          summaryLines.push(`- Files with matches: ${results.length}`);
          if (!filesOnly) {
            let snippetsAdded = 0;
            for (let i = 0; i < maxFilesForContext; i++) {
              const r = results[i];
              const fileRel = formatPathForPrint(r.file);
              const take = Math.min(r.matches.length, 3);
              const snippet = r.matches.slice(0, take).filter(m => m !== '__file_only__').map(m => `  - ${fileRel}${showLine && m.line ? `:${m.line}` : ''}: ${m.text}`).join('\n');
              if (snippet) {
                summaryLines.push(snippet);
                snippetsAdded += take;
              } else {
                summaryLines.push(`  - ${fileRel}`);
              }
              if (snippetsAdded >= 20) break;
            }
          }
          messageHistory.push({ role: 'system', content: summaryLines.join('\n') });
          console.log(chalk.green(`\nAdded search summary to AI context (${results.length} file(s)).`));
        } catch {}
      }
      continue;
    } else if (question.toLowerCase().startsWith('\\cd ')) {
      const arg = question.slice(4).trim();
      changeWorkingDirectory(arg, false);
      continue;
    } else if (question.toLowerCase() === '\\cd') {
      console.log(chalk.yellow('Usage: \\cd <path>'));
      continue;
    } else if (question.toLowerCase() === '\\nav') {
      console.log(chalk.blue('Entering navigation mode...'));
      await startNavigationMode();
      continue;
    } else if (question.toLowerCase().startsWith('\\d ')) {
      // Direct to powerful model command
      const directQuestion = question.slice(3).trim();
      
      if (!directQuestion) {
        console.log(chalk.red('Please provide a question after \\d'));
        continue;
      }
      
      // No explicit user echo; prompt already shows cwd
      console.log(chalk.blue('Sending directly to powerful model...'));
      
      // Save the original agentMode.enabled setting
      const originalAgentMode = config.agentMode.enabled;
      
      // Temporarily disable agent mode to ensure we use the powerful model
      config.agentMode.enabled = false;
      
      // Get AI response
      const response = await askAI(directQuestion);
      
      // Restore original agent mode setting
      config.agentMode.enabled = originalAgentMode;
      
      // Add to input history if it's not empty
      if (directQuestion.trim() !== '' && !inputHistory.includes(directQuestion)) {
        inputHistory.push(directQuestion);
        
        // Limit history size
        if (inputHistory.length > 50) {
          inputHistory.shift();
        }
      }
      
      // Display response if it doesn't contain agent commands
      if (!response.match(/(\{\{agent:(fs|exec):(.+?)\}\}|\(Executed: (.+?)\))/g)) {
        console.log(formatAIResponse(response));
      }
      
      continue;
    } else if (question.toLowerCase() === '\\visual' || question.toLowerCase() === '\\v') {
      console.log(chalk.blue('Launching visual tri-pane mode... (V to toggle, C to chat, q to quit)'));
      try {
        let res = await startTui(currentWorkingDirectory, {
          threePane: true,
          autoScan: config.autoActions?.localSearchBeforeAI,
          onToggleAutoScan: async (v) => {
            config.autoActions.localSearchBeforeAI = !!v;
            saveConfig();
          },
          getChatLines: () => {
            const maxLines = 200;
            const out = [];
            const hist = messageHistory.slice(-40);
            for (const m of hist) {
              const role = m.role === 'user' ? 'You' : (m.role === 'assistant' ? 'AI' : 'Sys');
              const text = (m.content || '').replace(/\s+/g, ' ').slice(0, 160);
              out.push(`${role}: ${text}`);
              if (out.length >= maxLines) break;
            }
            return out;
          },
          onAsk: async (q) => {
            const ans = await askAI(q, { silent: true });
            // Auto-approve safe FS ops embedded in assistant messages (read/list/exists) silently
            try {
              const ops = [];
              const re = /\{\{agent:fs:(read|list|exists):([^}]+)\}\}/g;
              let m;
              while ((m = re.exec(ans)) !== null) {
                ops.push({ op: m[1], path: m[2].trim() });
              }
              if (ops.length) {
                const lines = [];
                for (const o of ops) {
                  const res = await handleFileOperation(o.op, { path: o.path });
                  if (res.success) {
                    if (o.op === 'read') {
                      const data = String(res.data || '');
                      lines.push(`Auto-approved read ${o.path} (showing first 200 lines):\n` + data.split(/\r?\n/).slice(0,200).join('\n'));
                    } else if (o.op === 'list') {
                      const items = Array.isArray(res.data) ? res.data.slice(0,200).join('\n') : String(res.data);
                      lines.push(`Auto-approved list ${o.path}:\n${items}`);
                    } else {
                      lines.push(`Auto-approved exists ${o.path}: ${res.data ? 'Yes' : 'No'}`);
                    }
                  } else {
                    lines.push(`Auto-approve failed for ${o.op} ${o.path}: ${res.error}`);
                  }
                }
                if (lines.length) {
                  messageHistory.push({ role: 'assistant', content: lines.join('\n\n') });
                }
              }
            } catch {}
            return ans;
          }
        });
        // Handle editor launch
        if (res && res.type === 'editFile' && res.path) {
          try {
            await startEditor(res.path, {
              onAsk: async (q) => await askAI(q, { silent: true })
            });
          } catch (e) {
            console.log(chalk.red(`Editor error: ${e.message}`));
          }
        }
      } catch (e) {
        console.log(chalk.red(`Visual mode error: ${e.message}`));
      }
      continue;
    } else if ((question.toLowerCase().startsWith('\\fs ') || question.toLowerCase().startsWith('\\f ')) && config.agent.enabled) {
      // Process file system command via direct command
      const command = question.toLowerCase().startsWith('\\fs ') ? question.slice(4) : question.slice(3);
      const parts = command.split(':');
      
      if (parts.length < 2) {
        console.log(chalk.red('Invalid file system command format. Use operation:path[:content]'));
        continue;
      }
      
      const operation = parts[0].trim();
      // Set base directory to current working directory
      let filePath = parts[1].trim();
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(currentWorkingDirectory, filePath);
      }
      const content = parts.length > 2 ? parts.slice(2).join(':').trim() : '';
      
      // Confirm operation with user
      const { confirmed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Confirm ${operation} operation on ${filePath}?`,
          default: false
        }
      ]);
      
      if (!confirmed) {
        console.log(chalk.yellow('Operation cancelled by user.'));
        continue;
      }
      
      // Execute the file operation
      const result = await handleFileOperation(operation, { 
        path: filePath, 
        content: content 
      });
      
      // Display result
      if (result.success) {
        if (result.data) {
          if (typeof result.data === 'boolean') {
            console.log(chalk.green(`File ${filePath} exists: ${result.data}`));
          } else if (Array.isArray(result.data)) {
            console.log(chalk.green(`Directory contents of ${filePath}:`));
            result.data.forEach(item => console.log(`  ${item}`));
          } else {
            // File content
            console.log(chalk.green(`Content of ${filePath}:`));
            console.log(boxen(result.data, {
              padding: 1,
              margin: 1,
              borderStyle: 'round',
              borderColor: 'green'
            }));
          }
        } else if (result.message) {
          console.log(chalk.green(result.message));
        }
        
        // Add to message history
        messageHistory.push({ 
          role: 'user', 
          content: `I performed a file system ${operation} on ${filePath}.` 
        });
        
        messageHistory.push({ 
          role: 'assistant', 
          content: `I see you performed a file system ${operation} on ${filePath}. ${
            result.data ? 
              (typeof result.data === 'string' ? 
                `The file contains ${result.data.length} characters.` : 
                (Array.isArray(result.data) ? 
                  `The directory contains ${result.data.length} items.` : 
                  `The file exists: ${result.data}.`
                )
              ) : 
              (result.message || 'The operation was successful.')
          }`
        });
      } else {
        console.log(chalk.red(`Error: ${result.error}`));
      }
      
      continue;
    } else if ((question.toLowerCase().startsWith('\\exec ') || question.toLowerCase().startsWith('\\e ')) && config.agent.enabled) {
      // Process terminal execution command
      const rawArg = question.toLowerCase().startsWith('\\exec ') ? question.slice(6) : question.slice(3);
      const nl = translateNaturalCommand(rawArg);
      const command = nl ? nl.cmd : rawArg;
      
      // Check if virtual environment is enabled
      const cmdPrefix = config.agent.useVirtualEnvironment ? 'docker run --rm alpine ' : '';

      // Auto-approve unless dangerous or disabled
      const dangerous = nl?.danger || isDangerousExec(command);
      let confirmed = true;
      if (!(config.agent.autoApproveExec && !dangerous)) {
        const ans = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirmed',
            message: `Run command${config.agent.useVirtualEnvironment ? ' in virtual environment' : ''}: ${command}?${nl ? `\n(From: ${rawArg})` : ''}`,
            default: false
          }
        ]);
        confirmed = ans.confirmed;
        if (!confirmed) {
          console.log(chalk.yellow('Command execution cancelled by user.'));
          continue;
        }
      }
      
      // Extra confirmation for risky operations
      const needsTypedConfirm = (nl && (nl.danger || nl.confirmWord)) || (!nl && isDangerousExec(command));
      if (needsTypedConfirm) {
        const word = (nl?.confirmWord || 'DELETE').toUpperCase();
        const msg = nl?.confirmMessage || (isDangerousExec(command) || nl?.danger 
          ? `Destructive operation detected${nl?.target ? ' on: ' + nl.target : ''}\nType ${word} to confirm:`
          : `Type ${word} to confirm:`);
        const { typed } = await inquirer.prompt([
          {
            type: 'input',
            name: 'typed',
            message: msg,
            validate: v => v.trim().toUpperCase() === word ? true : `Please type ${word} to confirm`
          }
        ]);
        if ((typed || '').trim().toUpperCase() !== word) {
          console.log(chalk.yellow('Operation cancelled by user.'));
          continue;
        }
      }
      
      console.log(chalk.blue('Executing command...'));
      
      try {
        // Execute the command
        const result = await executeCommand(cmdPrefix + command);
        
        // Display result
        console.log(chalk.green('Command output:'));
        console.log(boxen(result.stdout || 'Command executed successfully with no output.', {
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'green'
        }));
        
        if (result.stderr) {
          console.log(chalk.yellow('Command error output:'));
          console.log(boxen(result.stderr, {
            padding: 1,
            margin: 1,
            borderStyle: 'round',
            borderColor: 'yellow'
          }));
        }
        
        // Add to message history
        messageHistory.push({ 
          role: 'user', 
          content: `I executed the command: ${command}` 
        });
        
        messageHistory.push({ 
          role: 'assistant', 
          content: `I see you executed the command: ${command}. The command ${
            result.success ? 'completed successfully' : 'had some errors'
          }${result.stdout ? ' with output: ' + result.stdout.substring(0, 200) + (result.stdout.length > 200 ? '...' : '') : '.'}`
        });
      } catch (error) {
        console.log(chalk.red(`Error executing command: ${error.message}`));
      }
      
      continue;
    }
    
    // Legacy confirmation path removed; handled earlier via quick-approve
    if (false && (question.toLowerCase() === 'y' || question.toLowerCase() === 'yes')) {
      // Check previous AI response for a command
      if (messageHistory.length >= 1) {
        const lastAIResponse = messageHistory[messageHistory.length - 1]?.content || '';
        const commandMatch = lastAIResponse.match(/\{\{agent:(fs|exec):(.+?)\}\}/);
        
        if (commandMatch && config.agent.enabled) {
          // User is confirming to run the suggested command
          console.log(formatUserMessage(question));
          
          const [_, commandType, command] = commandMatch;
          
          // Execute the command directly without another confirmation
          if (commandType === 'fs') {
            // Parse file command
            const parts = command.split(':');
            const operation = parts[0].trim();
            // Set base directory to /Users/leland/Documents/
            let filePath = parts[1].trim();
            if (!filePath.startsWith('/Users/leland/Documents')) {
              filePath = path.join('/Users/leland/Documents', filePath);
            }
            const content = parts.length > 2 ? parts.slice(2).join(':').trim() : '';
            
            console.log(chalk.blue(`Executing file operation ${operation} on ${filePath}...`));
            
            const result = await handleFileOperation(operation, { 
              path: filePath, 
              content: content 
            });
            
            // Display result
            if (result.success) {
              if (result.data) {
                if (typeof result.data === 'boolean') {
                  console.log(chalk.green(`File ${filePath} exists: ${result.data}`));
                } else if (Array.isArray(result.data)) {
                  console.log(chalk.green(`Directory contents of ${filePath}:`));
                  result.data.forEach(item => console.log(`  ${item}`));
                } else {
                  // File content
                  console.log(chalk.green(`Content of ${filePath}:`));
                  console.log(boxen(result.data, {
                    padding: 1,
                    margin: 1,
                    borderStyle: 'round',
                    borderColor: 'green'
                  }));
                }
              } else if (result.message) {
                console.log(chalk.green(result.message));
              }
            } else {
              console.log(chalk.red(`Error: ${result.error}`));
            }
          } else {
            // Execute terminal command
            console.log(chalk.blue(`Executing command: ${command}`));
            
            try {
              const result = await executeCommand(command);
              
              // Display result
              console.log(chalk.green('Command output:'));
              console.log(boxen(result.stdout || 'Command executed successfully with no output.', {
                padding: 1,
                margin: 1,
                borderStyle: 'round',
                borderColor: 'green'
              }));
              
              if (result.stderr) {
                console.log(chalk.yellow('Command error output:'));
                console.log(boxen(result.stderr, {
                  padding: 1,
                  margin: 1,
                  borderStyle: 'round',
                  borderColor: 'yellow'
                }));
              }
            } catch (error) {
              console.log(chalk.red(`Error executing command: ${error.message}`));
            }
          }
          
          // Update message history
          messageHistory.push({ 
            role: 'user', 
            content: `Yes, please execute the command: ${command}` 
          });
          
          // Get new AI response after command execution
          const newResponse = await askAI(`I've executed the command "${command}" as you suggested. What's next?`);
          console.log(formatAIResponse(newResponse));
          
          continue;
        }
      }
    } else if (question.toLowerCase() === '\\terminal' || question.toLowerCase() === '\\term' || 
               question.toLowerCase() === '/terminal' || question.toLowerCase() === '/t') {
      await startTerminalMode();
      continue;
    } else if (terminalModeActive && !question.startsWith('/')) {
      // In terminal mode, execute the input directly as a command
      console.log(chalk.blue(`Executing: ${question}`));
      
      try {
        // Execute command with terminal mode flag set to true
        const result = await executeCommand(question, true);
        
        // Display result
        if (result.stdout && result.stdout.trim()) {
          console.log(boxen(result.stdout, {
            padding: 1,
            margin: 1,
            borderStyle: 'round',
            borderColor: 'green'
          }));
        }
        
        if (result.stderr && result.stderr.trim()) {
          console.log(chalk.yellow('Error output:'));
          console.log(boxen(result.stderr, {
            padding: 1,
            margin: 1,
            borderStyle: 'round',
            borderColor: 'yellow'
          }));
        }
        
        console.log(chalk.green(`Current directory: ${currentWorkingDirectory}`));
      } catch (error) {
        console.log(chalk.red(`Error executing command: ${error.message}`));
      }
      
      continue;
    }
    
    // If not a simple confirmation, get AI response normally
    const response = await askAI(question);
    
    // Add the question to input history if it's not a command and not empty
    const historyQuestion = question.replace(/^\\(a|agent|agentic)\b\s*/i, '');
    if (!question.startsWith('/') && historyQuestion.trim() !== '' && 
        !inputHistory.includes(historyQuestion) && question !== 'y' && question !== 'yes') {
      inputHistory.push(historyQuestion);
      
      // Limit history size to prevent memory issues
      if (inputHistory.length > 50) {
        inputHistory.shift();
      }
    }
    
    // Only display the response if it doesn't contain agent commands
    // (if it has agent commands, it's already displayed in askAI)
    if (!response.match(/(\{\{agent:(fs|exec):(.+?)\}\}|\(Executed: (.+?)\))/g)) {
      console.log(formatAIResponse(response));
      
      // In coding mode, update the conversation file with Q&A
      if (config.codingMode.enabled) {
        updateConversationFile(question, response);
      }
      
      // Removed auto-prompt for creating agentic tasks; use \a prefix instead
    }
  }
}

// Main CLI configuration
program
  .name('qa')
  .description('QA - Terminal AI Assistant with multi-provider support, coding assistance, and agentic parallel execution')
  .version('1.0.0')
  .option('--qs, --quiet-start', 'Quiet start (suppress banner and startup messages)')
  .option('--fa, --fast-answers', 'Fast answers mode (quick responses, no reasoning)')
  .option('--nvim, --nvim-help', 'Neovim help mode (vim/nvim keybinding assistance)')
  .option('--vocab, --vocabulary', 'Vocabulary mode (spelling, grammar, and writing assistance)');

// Enrich CLI help output with examples and notes
program.addHelpText('after', `\nExamples:\n  $ qa --qs\n  $ qa --fast-answers\n  $ qa --nvim\n  $ qa --vocab\n  $ qa settings\n\nSpecial Modes:\n  - Fast Answers: Quick responses without reasoning for simple questions\n  - Nvim Help: Lightning-fast vim/neovim keybinding assistance\n  - Vocabulary: Spelling, grammar, and professional writing assistance\n\nNotes:\n  - Inside chat, commands start with \\ (backslash). Forward-slash / is supported but deprecated.\n  - Paste mode: type \\p, finish with \\end (Windows: Ctrl+Z then Enter).\n  - Agentic: prefix a single query with \\a (or \\agent, \\agentic).\n  - Exec: use \\e or \\exec to run commands; common natural-language ops are translated (e.g.,\n    "make a new directory ~/Documents/testabc", "open terminal here",\n    "zip each of src docs", "replace 'old' with 'new' in files matching *.js under ./src").\n`);

// Default command starts chat mode
program
  .action(async () => {
    // Load configuration
    loadConfig();
    
    // Configure special modes based on startup flags
    if (fastAnswersMode) {
      config.fastAnswersMode.enabled = true;
      config.reasoningMode.enabled = false;
      config.agentMode.enabled = false;
      config.agentic.enabled = false;
      config.codingMode.enabled = false;
    }
    
    if (nvimHelpMode) {
      config.nvimHelpMode.enabled = true;
      config.reasoningMode.enabled = false;
      config.agentMode.enabled = false;
      config.agentic.enabled = false;
      config.codingMode.enabled = false;
    }
    
    if (vocabMode) {
      config.vocabMode.enabled = true;
      config.reasoningMode.enabled = false;
      config.agentMode.enabled = false;
      config.agentic.enabled = false;
      config.codingMode.enabled = false;
    }
    
    await startChatMode();
  });

// Settings command
program
  .command('settings')
  .description('Configure AI providers, models, and special modes')
  .action(async () => {
    loadConfig();
    await configureSettings();
  });

// Add help for special modes
program
  .command('help-modes')
  .description('Show detailed information about special modes (Agent, Reasoning, Coding, Agentic)')
  .action(() => {
    console.log(chalk.cyan.bold('\nQA Terminal - Special Modes\n'));
    
    console.log(chalk.yellow.bold('Agent Mode:'));
    console.log('- Automatically classifies queries by complexity');
    console.log('- Routes simple queries to lightweight models (faster & cheaper)');
    console.log('- Routes complex queries to powerful models (better quality)');
    console.log('- Enable in settings or with the /menu command\n');
    
    console.log(chalk.yellow.bold('Reasoning Mode:'));
    console.log('- Applies iterative self-improvement to solve complex problems');
    console.log('- Breaks down problems into multiple reasoning steps');
    console.log('- Can show intermediate reasoning steps if configured');
    console.log('- Enable in settings or with the /menu command\n');
    
    console.log(chalk.yellow.bold('Coding Mode:'));
    console.log('- Creates and maintains project-specific context in ai.md');
    console.log('- Stores conversation in current.md for persistence');
    console.log('- Allows compacting/summarizing conversation with /compact');
    console.log('- Tracks features with /feature command');
    console.log('- Uses expanded context window for better code assistance');
    console.log('- Enable in settings or with the /menu command\n');
    
    console.log(chalk.yellow.bold('Agentic Mode:'));
    console.log('- Multi-threaded parallel agent execution architecture');
    console.log('- Conductor agent plans and coordinates complex tasks');
    console.log('- Worker agents execute specialized actions in parallel');
    console.log('- Uses /agentic or /schedule to toggle');
    console.log('- Create tasks with /task command');
    console.log('- Monitor progress with /status');
    console.log('- Grant permissions with /continue');
    console.log('- Cancel tasks with /cancel-task');
    console.log('- Toggle conductor model with /smart-conductor\n');
    
    console.log(chalk.cyan('Use "qa help" for general commands and "qa settings" to configure modes.'));
  });

// Help for coding mode
program
  .command('coding')
  .description('Show information about coding mode with project context management')
  .action(() => {
    console.log(chalk.cyan.bold('\nQA Terminal - Coding Mode\n'));
    
    console.log('The coding mode enhances AI assistance for software development projects');
    console.log('by maintaining persistent project context and optimizing conversations.\n');
    
    console.log(chalk.yellow.bold('Key Features:'));
    console.log('- Project-specific context management');
    console.log('- Conversation history tracking and summarization');
    console.log('- Feature tracking for documentation');
    console.log('- Expanded context window for better code understanding');
    console.log('- Integration with agentic mode for complex coding tasks\n');
    
    console.log(chalk.yellow.bold('Files Created:'));
    console.log(`- ${config.codingMode.projectContextFile}: Stores project information, features, and code structure`);
    console.log(`- ${config.codingMode.currentContextFile}: Maintains current conversation history\n`);
    
    console.log(chalk.yellow.bold('Commands:'));
    console.log('- /compact: Summarize the current conversation to preserve context');
    console.log('- /feature <description>: Add a new feature to the project context');
    console.log('- /clear: Clear conversation history and current.md file\n');
    
    console.log(chalk.yellow.bold('Benefits:'));
    console.log('- Better code suggestions through persistent project understanding');
    console.log('- Reduced need to repeat project details');
    console.log('- Automatically managed conversation history to prevent context overflow');
    console.log('- Documentation of project features as they are implemented\n');
    
    console.log(chalk.cyan('Enable coding mode in settings or through the /menu command.'));
  });

// Help for agentic mode
program
  .command('agentic')
  .description('Show information about agentic mode with parallel execution')
  .action(() => {
    console.log(chalk.cyan.bold('\nQA Terminal - Agentic Mode\n'));
    
    console.log('The agentic mode provides a powerful multi-agent, multi-threaded execution architecture');
    console.log('designed to handle complex tasks by breaking them down and executing in parallel.\n');
    
    console.log(chalk.yellow.bold('Key Features:'));
    console.log('- True parallel execution using Node.js worker threads');
    console.log('- Conductor-worker architecture for task planning and execution');
    console.log('- Dynamic task decomposition based on complexity');
    console.log('- Inter-agent communication and result sharing');
    console.log('- Permission management for long-running tasks');
    console.log('- Real-time task monitoring and status tracking\n');
    
    console.log(chalk.yellow.bold('Commands:'));
    console.log('- /agentic or /schedule: Toggle agentic mode on/off');
    console.log('- /task <description>: Create a new task with parallel agents');
    console.log('- /smart-conductor: Toggle using a powerful model as conductor');
    console.log('- /continue: Grant permission to agents to continue working');
    console.log('- /cancel-task: Cancel the current task');
    console.log('- /status: Show detailed task status and agent progress\n');
    
    console.log(chalk.yellow.bold('How It Works:'));
    console.log('1. The conductor agent analyzes the task and creates a detailed plan');
    console.log('2. The conductor determines which specialized agents are needed and their roles');
    console.log('3. Worker agents are launched in parallel threads to execute their tasks');
    console.log('4. Agents can share results according to the workflow dependencies');
    console.log('5. When all agents complete, the conductor synthesizes the final result\n');
    
    console.log(chalk.yellow.bold('Agent Types:'));
    console.log('- Research agents: Find and analyze information');
    console.log('- Coding agents: Generate, modify, or analyze code');
    console.log('- Analysis agents: Process and interpret data');
    console.log('- Filesystem agents: Interact with local files');
    console.log('- Automation agents: Perform system automation tasks\n');
    
    console.log(chalk.cyan('Enter chat and prefix a query with \\a to run it with agentic multi-agent execution.'));
  });

// Parse command line arguments
program
  .option('--whatmodes', 'Display available modes and startup arguments')
  .action((options) => {
    if (options.whatmodes) {
      console.log(chalk.bold.green('Available Modes and Startup Arguments:'));
      console.log('');
      console.log(chalk.bold('Normal Mode:'));
      console.log('  No special arguments needed.');
      console.log('');
      console.log(chalk.bold('Fast Answers Mode:'));
      console.log('  --fa, --fast-answers');
      console.log('');
      console.log(chalk.bold('Nvim Help Mode:'));
      console.log('  --nvim, --nvim-help');
      console.log('');
      console.log(chalk.bold('Vocabulary Mode:'));
      console.log('  --vocab, --vocabulary');
      console.log('');
      console.log(chalk.bold('Quiet Start:'));
      console.log('  --qs, --quiet-start');
      console.log('');
      process.exit(0);
    }
  });

program.parse(process.argv);

// Configure file/terminal agent settings
async function configureFileTerminalAgent() {
  const enableAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'agentEnabled',
      message: 'Enable agent capabilities (file system & terminal access)?',
      default: config.agent.enabled
    }
  ]);

  let hasChanged = config.agent.enabled !== enableAnswer.agentEnabled;
  config.agent.enabled = enableAnswer.agentEnabled;

  // Only ask for file/terminal agent settings if enabled
  if (enableAnswer.agentEnabled) {
    const agentAnswers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useVirtualEnvironment',
        message: 'Run commands in a virtual environment for safety?',
        default: config.agent.useVirtualEnvironment
      },
      {
        type: 'confirm',
        name: 'autoApproveExec',
        message: 'Auto-approve non-destructive exec commands (skip confirm)?',
        default: config.agent.autoApproveExec
      },
      {
        type: 'input',
        name: 'allowedDirectories',
        message: 'Allowed directories (comma-separated paths):',
        default: config.agent.allowedDirectories.join(','),
        filter: value => value.split(',').map(dir => dir.trim())
      }
    ]);
    
    hasChanged = hasChanged ||
      (config.agent.useVirtualEnvironment !== agentAnswers.useVirtualEnvironment) ||
      (config.agent.autoApproveExec !== agentAnswers.autoApproveExec) ||
      (JSON.stringify(config.agent.allowedDirectories) !== JSON.stringify(agentAnswers.allowedDirectories));
    
    config.agent.useVirtualEnvironment = agentAnswers.useVirtualEnvironment;
    config.agent.autoApproveExec = agentAnswers.autoApproveExec;
    config.agent.allowedDirectories = agentAnswers.allowedDirectories;
    
    // Manage disallowed commands
    const disallowedCommandsChoice = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Manage disallowed commands:',
        choices: ['Add a command', 'View current commands', 'Remove a command', 'Skip']
      }
    ]);
    
    if (disallowedCommandsChoice.action === 'Add a command') {
      const newCommandAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'newDisallowedCommand',
          message: 'Enter command to disallow:',
          validate: value => value.trim() !== '' ? true : 'Please enter a command'
        }
      ]);
      
      if (!config.agent.disallowedCommands.includes(newCommandAnswer.newDisallowedCommand)) {
        config.agent.disallowedCommands.push(newCommandAnswer.newDisallowedCommand);
        hasChanged = true;
        console.log(chalk.green(`✓ Added "${newCommandAnswer.newDisallowedCommand}" to disallowed commands`));
      }
    } else if (disallowedCommandsChoice.action === 'View current commands') {
      console.log(chalk.blue('Current disallowed commands:'));
      config.agent.disallowedCommands.forEach((cmd, i) => {
        console.log(chalk.blue(`  ${i+1}. ${cmd}`));
      });
    } else if (disallowedCommandsChoice.action === 'Remove a command' && config.agent.disallowedCommands.length > 0) {
      const removeCommandAnswer = await inquirer.prompt([
        {
          type: 'list',
          name: 'commandToRemove',
          message: 'Select command to remove:',
          choices: config.agent.disallowedCommands
        }
      ]);
      
      const index = config.agent.disallowedCommands.indexOf(removeCommandAnswer.commandToRemove);
      if (index !== -1) {
        config.agent.disallowedCommands.splice(index, 1);
        hasChanged = true;
        console.log(chalk.green(`✓ Removed "${removeCommandAnswer.commandToRemove}" from disallowed commands`));
      }
    }
    
    console.log(chalk.green('✓ File/Terminal agent configured'));
  }
  
  if (hasChanged) {
    saveConfig();
  }
  
  return hasChanged;
}

// Configure provider and model settings
async function configureProviderAndModel() {
  const providerAnswer = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Select AI provider:',
      choices: ['anthropic', 'openai', 'google', 'openrouter'],
      default: config.currentProvider
    }
  ]);
  
  // Check API keys for the selected provider
  if (providerAnswer.provider === 'openai' && !process.env.OPENAI_API_KEY) {
    console.log(chalk.red('Warning: OPENAI_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('You will need to set the OPENAI_API_KEY environment variable to use OpenAI.'));
  } else if (providerAnswer.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.log(chalk.red('Warning: ANTHROPIC_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('You will need to set the ANTHROPIC_API_KEY environment variable to use Anthropic Claude.'));
  } else if (providerAnswer.provider === 'google' && !process.env.GOOGLE_API_KEY) {
    console.log(chalk.red('Warning: GOOGLE_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('You will need to set the GOOGLE_API_KEY environment variable to use Google AI.'));
  } else if (providerAnswer.provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    console.log(chalk.red('Warning: OPENROUTER_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('You will need to set the OPENROUTER_API_KEY environment variable to use OpenRouter.'));
  }

  // Provider-specific main model selection
  const modelChoices = {
    openai: ['gpt-5', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    anthropic: ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20240620', 'claude-3-opus-20240229'],
    google: ['gemini-2.0-flash', 'gemini-2.5-pro-exp-03-25', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    openrouter: ['deepseek/deepseek-r1:free', 'deepseek/deepseek-chat', 'anthropic/claude-3-opus-20240229', 'anthropic/claude-3-5-sonnet-20240620']
  };

  const modelAnswer = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: `Select main ${providerAnswer.provider} model for complex queries:`,
      choices: modelChoices[providerAnswer.provider],
      default: config.models[providerAnswer.provider]
    }
  ]);

  // Update configuration
  const hasChanged = (config.currentProvider !== providerAnswer.provider) || 
                     (config.models[providerAnswer.provider] !== modelAnswer.model);
  
  config.currentProvider = providerAnswer.provider;
  config.models[providerAnswer.provider] = modelAnswer.model;

  if (hasChanged) {
    console.log(chalk.green(`✓ Now using ${chalk.bold(providerAnswer.provider)} with model ${chalk.bold(modelAnswer.model)}`));
    saveConfig();
  }
}

// Configure context settings
async function configureContextSettings() {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'contextSize',
      message: 'Max number of previous messages to keep in context:',
      default: config.maxContextMessages,
      validate: value => !isNaN(parseInt(value)) ? true : 'Please enter a valid number'
    }
  ]);

  const hasChanged = config.maxContextMessages !== parseInt(answers.contextSize);
  
  config.maxContextMessages = parseInt(answers.contextSize);
  
  if (hasChanged) {
    console.log(chalk.green(`✓ Context size set to ${chalk.bold(answers.contextSize)} messages`));
    saveConfig();
  }
}

// Configure coding mode settings
async function configureCodingMode() {
  const enableAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'codingModeEnabled',
      message: 'Enable coding mode with project-specific context management?',
      default: config.codingMode.enabled
    }
  ]);

  let hasChanged = config.codingMode.enabled !== enableAnswer.codingModeEnabled;
  config.codingMode.enabled = enableAnswer.codingModeEnabled;

  // Only ask for coding mode settings if enabled
  if (enableAnswer.codingModeEnabled) {
    const codingModeAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'codingContextSize',
        message: 'Max number of messages to keep in context for coding mode:',
        default: config.codingMode.maxContextMessages,
        validate: value => !isNaN(parseInt(value)) ? true : 'Please enter a valid number'
      },
      {
        type: 'input',
        name: 'projectContextFile',
        message: 'Project context file name:',
        default: config.codingMode.projectContextFile
      },
      {
        type: 'input',
        name: 'currentContextFile',
        message: 'Current conversation file name:',
        default: config.codingMode.currentContextFile
      }
    ]);
    
    hasChanged = hasChanged || 
      (config.codingMode.maxContextMessages !== parseInt(codingModeAnswers.codingContextSize)) ||
      (config.codingMode.projectContextFile !== codingModeAnswers.projectContextFile) ||
      (config.codingMode.currentContextFile !== codingModeAnswers.currentContextFile);
    
    config.codingMode.maxContextMessages = parseInt(codingModeAnswers.codingContextSize);
    config.codingMode.projectContextFile = codingModeAnswers.projectContextFile;
    config.codingMode.currentContextFile = codingModeAnswers.currentContextFile;
    
    console.log(chalk.green('✓ Coding mode configured'));
    
    // Initialize coding mode files
    if (config.codingMode.enabled) {
      initializeCodingMode();
    }
  }
  
  if (hasChanged) {
    saveConfig();
  }
}

// Configure agent mode settings
async function configureAgentMode() {
  const enableAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'agentModeEnabled',
      message: 'Enable agent mode with query classification and model routing?',
      default: config.agentMode.enabled
    }
  ]);

  let hasChanged = config.agentMode.enabled !== enableAnswer.agentModeEnabled;
  config.agentMode.enabled = enableAnswer.agentModeEnabled;

  // Only ask for agent mode settings if enabled
  if (enableAnswer.agentModeEnabled) {
    const agentModeAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'routingThreshold',
        message: 'Confidence threshold for routing queries (0.0-1.0):',
        default: config.agentMode.routingThreshold,
        validate: value => {
          const num = parseFloat(value);
          return (!isNaN(num) && num >= 0 && num <= 1) ? 
            true : 'Please enter a number between 0 and 1';
        }
      }
    ]);
    
    hasChanged = hasChanged || (config.agentMode.routingThreshold !== parseFloat(agentModeAnswers.routingThreshold));
    config.agentMode.routingThreshold = parseFloat(agentModeAnswers.routingThreshold);
    
    // Configure lightweight models
    const lightModelChoices = {
      openai: ['gpt-5-mini', 'gpt-4o-mini', 'gpt-3.5-turbo'],
      anthropic: ['claude-3-haiku-20240307'],
      google: ['gemini-2.0-flash-lite', 'gemini-1.5-flash-8b'],
      openrouter: ['deepseek/deepseek-r1:free']
    };
    
    const lightModelAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'lightModel',
        message: `Select lightweight ${config.currentProvider} model for simple queries:`,
        choices: lightModelChoices[config.currentProvider],
        default: config.lightModels[config.currentProvider]
      }
    ]);
    
    hasChanged = hasChanged || (config.lightModels[config.currentProvider] !== lightModelAnswer.lightModel);
    config.lightModels[config.currentProvider] = lightModelAnswer.lightModel;
    
    console.log(chalk.green(`✓ Agent mode enabled with ${chalk.bold(config.lightModels[config.currentProvider])} for simple queries`));
    console.log(chalk.green(`✓ Routing threshold set to ${chalk.bold(config.agentMode.routingThreshold)}`));
  }
  
  if (hasChanged) {
    saveConfig();
  }
}

// Configure reasoning mode settings
async function configureReasoningMode() {
  const enableAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'reasoningEnabled',
      message: 'Enable reasoning mode for complex problems?',
      default: config.reasoningMode.enabled
    }
  ]);

  let hasChanged = config.reasoningMode.enabled !== enableAnswer.reasoningEnabled;
  config.reasoningMode.enabled = enableAnswer.reasoningEnabled;

  // Only ask for reasoning mode settings if enabled
  if (enableAnswer.reasoningEnabled) {
    const reasoningModeAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'iterations',
        message: 'Number of reasoning iterations (1-5):',
        default: config.reasoningMode.iterations,
        validate: value => {
          const num = parseInt(value);
          return (!isNaN(num) && num >= 1 && num <= 5) ? 
            true : 'Please enter a number between 1 and 5';
        }
      },
      {
        type: 'confirm',
        name: 'showIntermediate',
        message: 'Show intermediate reasoning steps?',
        default: config.reasoningMode.showIntermediate
      }
    ]);
    
    hasChanged = hasChanged || 
      (config.reasoningMode.iterations !== parseInt(reasoningModeAnswers.iterations)) ||
      (config.reasoningMode.showIntermediate !== reasoningModeAnswers.showIntermediate);
    
    config.reasoningMode.iterations = parseInt(reasoningModeAnswers.iterations);
    config.reasoningMode.showIntermediate = reasoningModeAnswers.showIntermediate;
    
    console.log(chalk.green('✓ Reasoning mode configured'));
  }
  
  if (hasChanged) {
    saveConfig();
  }
}

// Configure agentic mode settings
async function configureAgenticMode() {
  const enableAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'agenticEnabled',
      message: 'Enable agentic mode with multi-agent orchestration?',
      default: config.agentic.enabled
    }
  ]);

  let hasChanged = config.agentic.enabled !== enableAnswer.agenticEnabled;
  config.agentic.enabled = enableAnswer.agenticEnabled;

  // Only ask for agentic mode settings if enabled
  if (enableAnswer.agenticEnabled) {
    const agenticModeAnswers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'usePowerfulConductor',
        message: 'Use powerful model as task conductor?',
        default: config.agentic.usePowerfulConductor
      },
      {
        type: 'input',
        name: 'maxConcurrentAgents',
        message: 'Maximum number of concurrent agents (1-10):',
        default: config.agentic.maxConcurrentAgents,
        validate: value => {
          const num = parseInt(value);
          return (!isNaN(num) && num >= 1 && num <= 10) ? 
            true : 'Please enter a number between 1 and 10';
        }
      },
      {
        type: 'input',
        name: 'maxActionsPerAgent',
        message: 'Maximum actions per agent before permission (1-100):',
        default: config.agentic.maxActionsPerAgent,
        validate: value => {
          const num = parseInt(value);
          return (!isNaN(num) && num >= 1 && num <= 100) ? 
            true : 'Please enter a number between 1 and 100';
        }
      }
    ]);
    
    hasChanged = hasChanged ||
      (config.agentic.usePowerfulConductor !== agenticModeAnswers.usePowerfulConductor) ||
      (config.agentic.maxConcurrentAgents !== parseInt(agenticModeAnswers.maxConcurrentAgents)) ||
      (config.agentic.maxActionsPerAgent !== parseInt(agenticModeAnswers.maxActionsPerAgent));
    
    config.agentic.usePowerfulConductor = agenticModeAnswers.usePowerfulConductor;
    config.agentic.maxConcurrentAgents = parseInt(agenticModeAnswers.maxConcurrentAgents);
    config.agentic.maxActionsPerAgent = parseInt(agenticModeAnswers.maxActionsPerAgent);
    
    console.log(chalk.green('✓ Agentic mode configured'));
  }
  
  if (hasChanged) {
    saveConfig();
  }
}

// Configure automatic local scan settings
async function configureAutoActions() {
  const enableAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'localSearchBeforeAI',
      message: 'Enable automatic local project scan before AI for feature-style queries?',
      default: config.autoActions.localSearchBeforeAI
    }
  ]);

  let hasChanged = config.autoActions.localSearchBeforeAI !== enableAnswer.localSearchBeforeAI;
  config.autoActions.localSearchBeforeAI = enableAnswer.localSearchBeforeAI;

  if (enableAnswer.localSearchBeforeAI) {
    const detailAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'maxGrepHits',
        message: 'Maximum total grep hits (10-500):',
        default: String(config.autoActions.maxGrepHits),
        validate: v => {
          const n = parseInt(v, 10);
          return (!isNaN(n) && n >= 10 && n <= 500) ? true : 'Enter a number between 10 and 500';
        }
      },
      {
        type: 'input',
        name: 'maxSnippetsPerFile',
        message: 'Maximum snippets per file (1-10):',
        default: String(config.autoActions.maxSnippetsPerFile),
        validate: v => {
          const n = parseInt(v, 10);
          return (!isNaN(n) && n >= 1 && n <= 10) ? true : 'Enter a number between 1 and 10';
        }
      },
      {
        type: 'input',
        name: 'snippetContext',
        message: 'Context lines around match (0-10):',
        default: String(config.autoActions.snippetContext),
        validate: v => {
          const n = parseInt(v, 10);
          return (!isNaN(n) && n >= 0 && n <= 10) ? true : 'Enter a number between 0 and 10';
        }
      }
    ]);

    const newMaxHits = parseInt(detailAnswers.maxGrepHits, 10);
    const newMaxPerFile = parseInt(detailAnswers.maxSnippetsPerFile, 10);
    const newCtx = parseInt(detailAnswers.snippetContext, 10);

    hasChanged = hasChanged ||
      (config.autoActions.maxGrepHits !== newMaxHits) ||
      (config.autoActions.maxSnippetsPerFile !== newMaxPerFile) ||
      (config.autoActions.snippetContext !== newCtx);

    config.autoActions.maxGrepHits = newMaxHits;
    config.autoActions.maxSnippetsPerFile = newMaxPerFile;
    config.autoActions.snippetContext = newCtx;
  }

  if (hasChanged) {
    saveConfig();
    console.log(chalk.green('✓ Automatic local scan settings saved'));
  }
}

// Add this function for terminal mode with tab completion
async function startTerminalMode() {
  console.log(chalk.cyan('Entering terminal mode. Type "exit" to return to chat.'));
  console.log(chalk.yellow('Current directory: ' + process.cwd()));
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${process.cwd()}> `,
    completer: (line) => {
      try {
        // Handle empty input
        if (!line) {
          return [fs.readdirSync('.'), line];
        }
        
        // Extract the last token for completion (handle spaces properly)
        const tokens = line.split(/\s+/);
        const lastToken = tokens.pop() || '';
        
        // Handle relative paths
        let dir = '.';
        let base = lastToken;
        
        if (lastToken.includes('/')) {
          dir = path.dirname(lastToken);
          base = path.basename(lastToken);
        }
        
        // Get matching files
        const files = fs.readdirSync(dir === '' ? '.' : dir);
        const matches = files.filter(file => file.startsWith(base));
        
        return [matches.length ? matches.map(match => {
          const fullPath = path.join(dir === '.' ? '' : dir, match);
          try {
            return fs.statSync(fullPath).isDirectory() ? `${fullPath}/` : fullPath;
          } catch (err) {
            return fullPath;
          }
        }) : [], lastToken];
      } catch (error) {
        return [[], line];
      }
    }
  });
  
  return new Promise((resolve) => {
    rl.prompt();
    
    rl.on('line', async (line) => {
      const trimmedLine = line.trim();
      
      if (trimmedLine === 'exit') {
        rl.close();
        return;
      }
      
      if (!trimmedLine) {
        rl.prompt();
        return;
      }
      
      try {
        // Handle built-in commands
        if (trimmedLine === 'pwd') {
          console.log(process.cwd());
        } else if (trimmedLine.startsWith('cd ')) {
          const newDir = trimmedLine.substring(3);
          try {
            process.chdir(newDir);
            rl.setPrompt(`${process.cwd()}> `);
          } catch (error) {
            console.error(`Error: ${error.message}`);
          }
        } else if (trimmedLine === 'ls' || trimmedLine === 'dir') {
          const files = fs.readdirSync('.');
          console.log(files.join('\n'));
        } else {
          // Execute the command
          const { stdout, stderr } = await executeCommand(trimmedLine, true);
          if (stdout) console.log(stdout);
          if (stderr) console.error(chalk.red(stderr));
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
      }
      
      rl.prompt();
    });
    
    rl.on('close', () => {
      console.log(chalk.cyan('Exiting terminal mode.'));
      resolve();
    });
  });
}

// Complete the formatProjectReport function
function formatProjectReport(stats) {
  let report = `# Project Review: ${stats.name}\n\n`;
  
  report += `## Basic Information\n`;
  report += `- **Project path:** ${stats.path}\n`;
  report += `- **Project type:** ${stats.projectType}\n`;
  report += `- **Git repository:** ${stats.isGitRepo ? 'Yes' : 'No'}\n\n`;
  
  report += `## Project Structure\n`;
  report += `- **Top-level directories:** ${stats.topLevelDirs.join(', ') || 'None'}\n`;
  report += `- **Total files:** ${stats.fileCount}\n`;
  report += `- **Total directories:** ${stats.directoryCount}\n`;
  report += `- **Total size:** ${stats.totalSize}\n\n`;
  
  if (stats.importantFiles.length > 0) {
    report += `## Important Files\n`;
    stats.importantFiles.forEach(file => {
      report += `- ${file}\n`;
    });
    report += '\n';
  }
  
  report += `## File Types\n`;
  const sortedFileTypes = Object.entries(stats.fileTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  
  if (sortedFileTypes.length > 0) {
    sortedFileTypes.forEach(([ext, count]) => {
      report += `- ${ext}: ${count} files\n`;
    });
  } else {
    report += `- No files found\n`;
  }
  
  // Add recommendations section based on project type
  report += `\n## Recommendations\n`;
  
  if (!stats.isGitRepo) {
    report += `- Initialize a git repository with \`git init\`\n`;
  }
  
  if (!stats.importantFiles.includes('README.md')) {
    report += `- Create a README.md file to document your project\n`;
  }
  
  if (!stats.importantFiles.includes('.gitignore')) {
    report += `- Add a .gitignore file to exclude unnecessary files from version control\n`;
  }
  
  // Project type specific recommendations
  if (stats.projectType.includes('JavaScript') || stats.projectType.includes('TypeScript')) {
    if (!stats.importantFiles.includes('package.json')) {
      report += `- Initialize npm with \`npm init\`\n`;
    }
    
    if (!stats.importantFiles.includes('.eslintrc.js') && !stats.importantFiles.includes('.eslintrc.json')) {
      report += `- Consider adding ESLint for code quality: \`npm install eslint --save-dev\`\n`;
    }
    
    if (!stats.importantFiles.includes('jest.config.js') && !stats.importantFiles.includes('jest.config.ts')) {
      report += `- Consider adding Jest for testing: \`npm install jest --save-dev\`\n`;
    }
  } else if (stats.projectType.includes('Python')) {
    if (!stats.importantFiles.includes('requirements.txt')) {
      report += `- Create a requirements.txt file to track dependencies\n`;
    }
    
    if (!stats.importantFiles.includes('setup.py') && !stats.importantFiles.includes('pyproject.toml')) {
      report += `- Consider making your project installable with setup.py or pyproject.toml\n`;
    }
    
    if (!stats.importantFiles.includes('.env') && !stats.importantFiles.includes('.env.example')) {
      report += `- Consider adding a .env file for environment variables\n`;
    }
  }
  
  return report;
}

// Utility function: Formats bytes to a human-readable format
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Check if a directory exists
function directoryExists(basePath, dirName) {
  const dirPath = path.join(basePath, dirName);
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

// Check if a file contains a specific string
function fileContains(filePath, searchString) {
  if (!fs.existsSync(filePath)) return false;
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.includes(searchString);
  } catch (error) {
    return false;
  }
}

// Check if a directory contains a file with name containing a pattern
function directoryContainsFile(dirPath, searchPattern) {
  if (!fs.existsSync(dirPath)) return false;
  
  try {
    const filesInDir = fs.readdirSync(dirPath);
    return filesInDir.some(file => file.includes(searchPattern));
  } catch (error) {
    return false;
  }
}
      
