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

// Setup __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store the original installation directory
const installDir = __dirname;

// Save the caller's working directory
const callerDir = process.cwd();

// Change to the caller's directory to operate from there
console.log(chalk.gray(`Starting from: ${callerDir}`));

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
    console.log(chalk.blue('Paste Mode: Paste your multiline text and press "Cmd+/" to finish'));
    console.log(chalk.blue('You can also type "\\end" on a new line to finish paste mode'));
    console.log(chalk.gray('(Or press Ctrl+C to cancel)'));
    
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

      // Check for Cmd+/ or explicit \end markers
      if (data.trim() === '\\end' || data.includes('\\end\n') || data.includes('\\end\r\n')) {
        let cleanedBuffer = buffer;
        if (data.trim() === '\\end') {
          cleanedBuffer = buffer.replace(/\\end$/, '');
        } else if (data.includes('\\end\n')) {
          cleanedBuffer = buffer.replace(/\\end\n/, '');
        } else if (data.includes('\\end\r\n')) {
          cleanedBuffer = buffer.replace(/\\end\r\n/, '');
        }
        cleanup();
        resolve(cleanedBuffer);
        return;
      }

      buffer += data;
    };
    
    // Set up the handlers
    process.stdin.on('data', dataHandler);
    
    // Add a 30-second timeout to avoid hanging
    let timeoutId = setTimeout(() => {
      console.log(chalk.yellow('Paste mode timed out after 30 seconds'));
      cleanup();
      resolve(buffer || '');
    }, 30000);
    
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

// Add automatic multiline paste detection - disabled
globalThis.isMultilinePaste = (input) => {
  // Explicit disabling of automatic multiline paste detection
  // Users should use \p or \paste command instead
  return false;
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
    taskHistoryFile: 'tasks.json', // File to store task execution history
    taskTypes: [
      'research',   // Web research tasks
      'coding',     // Code generation and modification
      'analysis',   // Data or code analysis
      'filesystem', // File operations
      'automation'  // Local automation tasks
    ],
    historyPath: __dirname // In your config initialization or wherever you set up default config values
  }
};

// Message history for context
let messageHistory = [];

// User input history for up/down navigation
let inputHistory = [];
let inputHistoryIndex = -1;

// Agentic mode state
let taskManager = null;
let activeTaskId = null;

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
    const taskHistoryPath = path.join(config.agentic?.historyPath || __dirname, 'task-history.json');
    
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
  
  // Save task history to file
  saveTaskHistory() {
    const taskHistoryPath = path.join(installDir, config.agentic.taskHistoryFile);
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
            temperature: 0.7,
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
            temperature: 0.5,
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
            temperature: 0.1,
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
            temperature: 0.3,
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

// ASCII art logo with gradient colors
function displayLogo() {
  console.clear();
  const logo = figlet.textSync('QA', {
    font: 'ANSI Shadow',
    horizontalLayout: 'full'
  });
  
  console.log(gradient.pastel.multiline(logo));
  console.log(chalk.cyan('Your AI Assistant Terminal') + '\n');
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
      
      config = { ...config, ...loadedConfig };
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
            temperature: 0.7,
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
          temperature: 0.7,
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
          temperature: 0.1,
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
async function askAI(question) {
  // Check if agentic mode should process this query
  if (config.agentic && config.agentic.enabled && config.agentic.autoDetect && 
      !question.startsWith('/') && !activeTaskId && await shouldUseAgentic(question)) {
    
    // Initialize task manager if needed
    if (!taskManager) {
      taskManager = new AgentTaskManager();
      
      // Set up event handlers for task manager
      taskManager.on('task-planned', (task) => {
        console.log(chalk.green(`✓ Task planned with ${task.plan.agentCount} agents`));
      });
      
      taskManager.on('task-executing', (task) => {
        console.log(chalk.green(`✓ Executing with ${task.agents.length} agents in parallel`));
      });
      
      taskManager.on('agent-progress', (data) => {
        console.log(chalk.blue(`Agent ${data.agent.role}: Completed action "${data.action}"`));
      });
      
      taskManager.on('task-completed', (result) => {
        console.log(chalk.green('Task completed!'));
        
        // If there's a summary, add it to message history
        if (result.summary) {
          messageHistory.push({ 
            role: 'assistant', 
            content: result.summary 
          });
          
          console.log(formatAIResponse(result.summary));
        }
        
        // Reset active task ID
        activeTaskId = null;
      });
      
      taskManager.on('task-error', (task) => {
        console.log(chalk.red(`Task error: ${task.error}`));
        activeTaskId = null;
      });
    }
    
    const spinner = ora('Processing with agentic mode...').start();
    try {
      // Create a new task with the default conductor setting
      activeTaskId = await taskManager.createTask(question, config.agentic.usePowerfulConductor);
      spinner.succeed(chalk.green(`Parallel processing started`));
      
      // Return placeholder - actual results will come from task completion events
      return "Processing your request with multiple AI agents in parallel...";
    } catch (error) {
      spinner.fail(chalk.red(`Error in agentic processing: ${error.message}`));
      console.log(chalk.yellow('Falling back to standard AI processing.'));
      // Continue with normal processing if agentic fails
    }
  }
  
  // Normal processing continues here
  try {
    const spinner = ora('Thinking...').start();
    let response = '';
    
    // Add question to history
    messageHistory.push({ role: 'user', content: question });
    
    // Limit history to the configured max context window
    const maxMessages = config.codingMode.enabled ? 
      config.codingMode.maxContextMessages : config.maxContextMessages;
    
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
    
    // Determine if we should use lightweight model based on agent mode
    let useMainModel = true;
    let modelDecision = "Using main model";
    let isDirectCmd = false;
    let skipReasoning = false;
    
    // Check if direct mode is enabled
    if (config.directMode && config.directMode.enabled) {
      useMainModel = true;
      modelDecision = "Using main model (direct mode enabled)";
      skipReasoning = config.directMode.skipReasoning;
    }
    // If not in direct mode, use agent mode if enabled
    else if (config.agentMode.enabled) {
      spinner.text = 'Analyzing query...';
      
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
      
      spinner.text = 'Thinking...';
    }
    
    // Create a context-aware history format for each provider
    switch (config.currentProvider) {
      case 'openai':
        const openaiMessages = [
          {
            role: 'system',
            content: `You are a helpful AI assistant in a terminal environment. ${isDirectCmd ? 
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
          temperature: 0.7,
        });
        
        response = openaiResponse.choices[0].message.content;
        break;
        
      case 'anthropic':
        if (!anthropic) {
          throw new Error('Anthropic API key not set or invalid. Please check your ANTHROPIC_API_KEY environment variable.');
        }
        // Format messages for Anthropic
        const anthropicSystemContent = `You are a helpful AI assistant in a terminal environment. ${isDirectCmd ? 
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
        const systemPrompt = `You are a helpful AI assistant in a terminal environment. ${isDirectCmd ? 
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
            content: `You are a helpful AI assistant in a terminal environment. ${isDirectCmd ? 
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
      console.log(chalk.gray(modelDecision));
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
              content: `You are a helpful AI assistant in a terminal environment. ${agentInstructions}`
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
              content: `You are a helpful AI assistant in a terminal environment. ${agentInstructions}`
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
              content: `You are a helpful AI assistant in a terminal environment. ${agentInstructions}`
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
              content: `You are a helpful AI assistant in a terminal environment. ${agentInstructions}`
            },
            ...messageHistory.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            }))
          ];
          break;
      }
      
      spinner.text = 'Applying reasoning steps...';
      
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
        spinner.succeed(chalk.blue('Reasoning complete!'));
        
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
      
      spinner.text = 'Thinking...';
    }
    
    // Check if AI response contains agent commands (either {{agent:...}} or (Executed: ...))
    const agentCommandRegex = /(\{\{agent:(fs|exec):(.+?)\}\}|\(Executed: (.+?)\))/g;
    let hasAgentCommands = response.match(agentCommandRegex);
    
    if (hasAgentCommands && config.agent.enabled) {
      // Add response to history temporarily
      messageHistory.push({ role: 'assistant', content: response });
      
      spinner.succeed(chalk.blue('Response received!'));
      
      // Display the response with the command suggestion
      console.log(formatAIResponse(response));
      
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
        // Ask user for permission
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirmed',
          message: `AI wants to ${cmd.commandType === 'fs' ? 'access file' : 'run command'}: ${cmd.command}\nAllow this operation?`,
          default: false
        }]);
        
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
            // Execute terminal command directly
            try {
              // Check if virtual environment is enabled
              const cmdPrefix = config.agent.useVirtualEnvironment ? 
                'docker run --rm alpine ' : '';
              
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
  console.log(chalk.blue(`Initializing coding mode in ${__dirname}`));
  
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
      
      console.log(chalk.green(`✓ Loaded project context (${contextContent.length} characters)`));
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
        console.log(chalk.green(`✓ Found existing conversation context (${conversationContent.length} characters)`));
        
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
          temperature: 0.3,
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
  displayLogo();
  
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
  
  console.log(chalk.cyan(`Current provider: ${chalk.bold(config.currentProvider)}`));
  
  // Show model info
  console.log(chalk.cyan(`Using model: ${chalk.bold(config.models[config.currentProvider])}`));
  
  // Show current mode status
  if (config.smartMode.enabled) {
    console.log(chalk.magenta('Smart Mode: Enabled - Lightweight model coordinates responses'));
    console.log(chalk.cyan(`Coordinator model: ${chalk.bold(config.lightModels[config.currentProvider])}`));
  } else {
    console.log(chalk.magenta('Powerful Mode: Enabled (default) - Powerful model handles all queries'));
  }
  
  // Show reasoning mode status
  if (config.directMode.skipReasoning) {
    console.log(chalk.magenta('Fast Mode: Enabled (default) - Reasoning disabled for faster responses'));
  } else if (config.reasoningMode.enabled) {
    console.log(chalk.magenta(`Reasoning: Enabled (${config.reasoningMode.iterations} iterations)`));
  }
  
  console.log(chalk.yellow('Type "/help" for available commands, "/exit", "/quit", or "/end" to quit'));
  
  // Show agent commands if enabled
  if (config.agent.enabled) {
    console.log(chalk.yellow('Agent commands: "/fs" for file operations, "/exec" for terminal commands'));
  }
  
  console.log(chalk.yellow('Type "\\p" or "\\paste" to enter multiline paste mode'));
  console.log(chalk.yellow('In paste mode, type "\\end" on a new line to finish pasting'));
  console.log(chalk.yellow('Use \\ at the end of a line + Enter for multi-line input'));
  console.log(chalk.yellow('Hotkeys: F8 copies last AI response to clipboard'));

  // Enable bracketed paste for robust multiline paste handling
  enableBracketedPaste();
  
  // Show new file operation functionality
  console.log(chalk.yellow('Auto-file-saving: AI can save files with ```tool_code {{agent:fs:write:file:content}} ``` syntax\n'));
  
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
          message: multilineInput ? 'Continue input:' : 'Ask a question:',
          prefix: '❯',
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
            // Submit the entire pasted content as one entry
            rl.line = bracketBuffer;
            rl.cursor = rl.line.length;
            bracketBuffer = '';
            // Emit line to resolve the prompt with this content
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
      
      // Check for paste command
      if (isPasteMode(userInput.trim())) {
        // User entered paste mode command - switch to enhanced paste mode
        console.log(chalk.blue('Entering paste mode...'));
        const pastedContent = await enhancedPasteMode();
        
        if (pastedContent) {
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
        continue;
      }
      
      // Remove event listeners to prevent duplicates in next iteration
      rl.input.removeAllListeners('keypress');
      rl.input.removeListener('data', dataListener);
      rl.removeAllListeners('line');
      rl.removeAllListeners('SIGINT');
    }
    
    const question = multilineInput.trim();
    
    // Check if this is an automatic multiline paste
    if (isMultilinePaste(question)) {
      console.log(chalk.blue('Detected multiline paste - processing directly...'));
      
      // Add to message history
      messageHistory.push({ role: 'user', content: question });
      
      // Display formatted user message
      console.log(formatUserMessage(question));
      
      // Get AI response
      const response = await askAI(question);
      
      // Add to input history
      if (!inputHistory.includes(question)) {
        inputHistory.push(question);
        
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
    
    // Handle special commands with forward slash
    if (question.toLowerCase() === '/exit' || question.toLowerCase() === '/quit' || question.toLowerCase() === '/end' || question.toLowerCase() === '/q') {
      console.log(chalk.yellow('Goodbye!'));
      break;
    } else if (question.toLowerCase() === '/clear' || question.toLowerCase() === '/c') {
      // Clear context and screen
      messageHistory = [];
      console.clear();
      displayLogo();
      
      // In coding mode, clear the current conversation file
      if (config.codingMode.enabled) {
        const currentContextPath = path.join(__dirname, config.codingMode.currentContextFile);
        try {
          fs.writeFileSync(currentContextPath, `# Current Conversation\n\nStarted: ${new Date().toISOString()}\n\n`);
          console.log(chalk.yellow('Terminal, context, and conversation file cleared!'));
        } catch (error) {
          console.error(chalk.red(`Error clearing conversation file: ${error.message}`));
          console.log(chalk.yellow('Terminal and context cleared!'));
        }
      } else {
        console.log(chalk.yellow('Terminal and context cleared!'));
      }
      continue;
    } else if (question.toLowerCase() === '/clearscreen' || question.toLowerCase() === '/cls') {
      // Clear just the screen
      console.clear();
      displayLogo();
      console.log(chalk.yellow('Terminal screen cleared!'));
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
    } else if (question.toLowerCase() === '\\help' || question.toLowerCase() === '\\h') {
      // Display help information
      console.log(chalk.cyan('Available Commands:'));
      console.log(chalk.yellow('- \\exit, \\quit, \\end, \\q - Quit the application'));
      console.log(chalk.yellow('- \\clear, \\c - Clear conversation history and terminal screen'));
      console.log(chalk.yellow('- \\cls or \\clearscreen - Clear only the terminal screen'));
      console.log(chalk.yellow('- \\menu, \\m - Access settings menu'));
      console.log(chalk.yellow('- \\help, \\h - Display this help information'));
      console.log(chalk.yellow('- \\d question - Send question directly to the powerful model (bypass routing)'));
      console.log(chalk.yellow('- \\direct, \\dr - Toggle direct mode (always use powerful model)'));
      console.log(chalk.yellow('- \\directfast, \\df - Toggle fast direct mode (powerful model with reasoning disabled)'));
      console.log(chalk.yellow('- \\home - Navigate to your home directory'));
      console.log(chalk.yellow('- \\start-project, \\new-project - Start a new coding project'));
      console.log(chalk.yellow('- \\review-project - Analyze the current project directory'));
      
      if (config.codingMode.enabled) {
        console.log(chalk.cyan('\nCoding Mode Commands:'));
        console.log(chalk.yellow('- \\compact, \\co - Summarize the current conversation to preserve context'));
        console.log(chalk.yellow('- \\clear, \\c - Clear conversation history and current.md file'));
        console.log(chalk.yellow('- \\feature <description>, \\ft <description> - Add a new feature to the project context'));
        console.log(chalk.yellow(`- Project context file: ${config.codingMode.projectContextFile}`));
      }
      
      console.log(chalk.cyan('\nAgentic Mode Commands (Multi-threaded Parallel Execution):'));
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
          
          // Display formatted user message
          console.log(formatUserMessage(pastedText.trim()));
          
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
    } else if (question.toLowerCase().startsWith('\\d ')) {
      // Direct to powerful model command
      const directQuestion = question.slice(3).trim();
      
      if (!directQuestion) {
        console.log(chalk.red('Please provide a question after \\d'));
        continue;
      }
      
      console.log(formatUserMessage(directQuestion));
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
      const command = question.toLowerCase().startsWith('\\exec ') ? question.slice(6) : question.slice(3);
      
      // Check if virtual environment is enabled
      const cmdPrefix = config.agent.useVirtualEnvironment ? 
        'docker run --rm alpine ' : '';
      
      // Confirm operation with user
      const { confirmed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Run command${config.agent.useVirtualEnvironment ? ' in virtual environment' : ''}: ${command}?`,
          default: false
        }
      ]);
      
      if (!confirmed) {
        console.log(chalk.yellow('Command execution cancelled by user.'));
        continue;
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
    
    // We no longer need this section as we're handling agent commands from AI responses only
    // This was for handling agent commands in user messages which is not our use case
    
    // Display user question
    console.log(formatUserMessage(question));
    
    // Check if this is a simple confirmation to execute previous command
    if (question.toLowerCase() === 'y' || question.toLowerCase() === 'yes') {
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
    if (!question.startsWith('/') && question.trim() !== '' && 
        !inputHistory.includes(question) && question !== 'y' && question !== 'yes') {
      inputHistory.push(question);
      
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
      
      // Check if this is a regular query in agentic mode and should be handled as a task
      if (config.agentic.enabled && taskManager && !question.startsWith('/') && 
          !activeTaskId && question.length > 10) {
        
        // Ask if user wants to create a task from this query
        const { createTask } = await inquirer.prompt([{
          type: 'confirm',
          name: 'createTask',
          message: 'Would you like to create an agentic task from this query?',
          default: false
        }]);
        
        if (createTask) {
          const spinner = ora('Creating task...').start();
          try {
            // Create a new task with the default conductor setting
            activeTaskId = await taskManager.createTask(
              question, 
              config.agentic.usePowerfulConductor
            );
            
            spinner.succeed(chalk.green(`Task created with ID: ${activeTaskId}`));
          } catch (error) {
            spinner.fail(chalk.red(`Error creating task: ${error.message}`));
          }
        }
      }
    }
  }
}

// Main CLI configuration
program
  .name('qa')
  .description('QA - Terminal AI Assistant with multi-provider support, coding assistance, and agentic parallel execution')
  .version('1.0.0');

// Default command starts chat mode
program
  .action(async () => {
    // Load configuration
    loadConfig();
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
    
    console.log(chalk.cyan('Enter the chat mode and use /agentic to start using this feature.'));
  });

// Parse command line arguments
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
        type: 'input',
        name: 'allowedDirectories',
        message: 'Allowed directories (comma-separated paths):',
        default: config.agent.allowedDirectories.join(','),
        filter: value => value.split(',').map(dir => dir.trim())
      }
    ]);
    
    hasChanged = hasChanged ||
      (config.agent.useVirtualEnvironment !== agentAnswers.useVirtualEnvironment) ||
      (JSON.stringify(config.agent.allowedDirectories) !== JSON.stringify(agentAnswers.allowedDirectories));
    
    config.agent.useVirtualEnvironment = agentAnswers.useVirtualEnvironment;
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
    openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
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
      openai: ['gpt-3.5-turbo'],
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
