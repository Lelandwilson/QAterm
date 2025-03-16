#!/usr/bin/env node

// QA - AI Terminal Application
// A terminal-based AI assistant that connects to multiple providers

process.removeAllListeners('warning');

// Import required packages
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
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

// Load environment variables
dotenv.config();

// Setup __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Application configuration
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {
  currentProvider: 'anthropic', // Default provider
  models: {
    openai: 'gpt-4o',
    anthropic: 'claude-3-7-sonnet-20250219',
    google: 'gemini-2.0-flash'
  },
  lightModels: {
    openai: 'gpt-3.5-turbo',
    anthropic: 'claude-3-haiku-20240307',
    google: 'gemini-2.0-flash-lite'
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
  }
};

// Message history for context
let messageHistory = [];

// User input history for up/down navigation
let inputHistory = [];
let inputHistoryIndex = -1;

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
      config = { ...config, ...JSON.parse(configData) };
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
    fs.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving config:', error.message);
    return false;
  }
}

// Format AI responses for better terminal display
function formatAIResponse(text) {
  return boxen(text, {
    padding: 1,
    margin: 1,
    borderStyle: 'round',
    borderColor: 'cyan',
    backgroundColor: '#222'
  });
}

// Format user messages for display
function formatUserMessage(text) {
  return chalk.green('You: ') + chalk.white(text);
}

// Agent capabilities - file system operations
async function handleFileOperation(operation, params) {
  // Validate operation is allowed
  const allowedOperations = ['read', 'write', 'list', 'exists'];
  if (!allowedOperations.includes(operation)) {
    return { success: false, error: `Operation ${operation} not allowed` };
  }

  // Validate path is within allowed directories
  // If path doesn't start with /Users/leland/Documents, prepend it
  let resolvedPath = params.path;
  if (!resolvedPath.startsWith('/Users/leland/Documents')) {
    resolvedPath = path.join('/Users/leland/Documents', resolvedPath);
  }
  
  const filePath = path.resolve(resolvedPath);
  const isAllowed = config.agent.allowedDirectories.some(dir => 
    filePath.startsWith(path.resolve(dir))
  );
  
  if (!isAllowed) {
    return { 
      success: false, 
      error: `Access to ${filePath} is not allowed. Only paths within ${config.agent.allowedDirectories.join(', ')} are permitted.`
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

function executeCommand(command) {
  return new Promise((resolve, reject) => {
    if (!isCommandAllowed(command)) {
      reject(new Error(`Command contains disallowed operations: ${command}`));
      return;
    }
    
    // Execute commands in /Users/leland/Documents by default
    const execOptions = { 
      cwd: '/Users/leland/Documents'
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
          const anthropicResponse = await anthropic.messages.create({
            model: model,
            messages: reasoningContext.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            })),
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
          messages: [
            { role: 'system', content: 'You are a helpful query classifier.' },
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
  try {
    const spinner = ora('Thinking...').start();
    let response = '';
    
    // Add question to history
    messageHistory.push({ role: 'user', content: question });
    
    // Limit history to the configured max context window
    if (messageHistory.length > config.maxContextMessages * 2) {
      // Keep only the most recent messages
      messageHistory = messageHistory.slice(-config.maxContextMessages * 2);
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
    
    if (config.agentMode.enabled) {
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
        const anthropicMessages = [
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
        
        const anthropicModel = useMainModel ? config.models.anthropic : config.lightModels.anthropic;
        
        const anthropicResponse = await anthropic.messages.create({
          model: anthropicModel,
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
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Select AI provider:',
      choices: ['anthropic', 'openai', 'google'],
      default: config.currentProvider
    },
    {
      type: 'input',
      name: 'contextSize',
      message: 'Max number of previous messages to keep in context:',
      default: config.maxContextMessages,
      validate: value => !isNaN(parseInt(value)) ? true : 'Please enter a valid number'
    },
    {
      type: 'confirm',
      name: 'agentModeEnabled',
      message: 'Enable agent mode with query classification and model routing?',
      default: config.agentMode.enabled
    },
    {
      type: 'confirm',
      name: 'agentEnabled',
      message: 'Enable agent capabilities (file system & terminal access)?',
      default: config.agent.enabled
    }
  ]);
  
  // Update configuration
  config.currentProvider = answers.provider;
  config.maxContextMessages = parseInt(answers.contextSize);
  config.agent.enabled = answers.agentEnabled;
  config.agentMode.enabled = answers.agentModeEnabled;
  
  // Configure agent mode settings if enabled
  if (answers.agentModeEnabled) {
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
    
    config.agentMode.routingThreshold = parseFloat(agentModeAnswers.routingThreshold);
    
    // Configure lightweight models if agent mode is enabled
    const lightModelChoices = {
      openai: ['gpt-3.5-turbo'],
      anthropic: ['claude-3-haiku-20240307'],
      google: ['gemini-2.0-flash-lite']
    };
    
    // Check if Google is selected but API key is not set
    if (answers.provider === 'google' && !process.env.GOOGLE_API_KEY) {
      console.log(chalk.red('Warning: GOOGLE_API_KEY environment variable is not set.'));
      console.log(chalk.yellow('You will need to set the GOOGLE_API_KEY environment variable to use Google AI.'));
      console.log(chalk.yellow('Please set it in your .env file or export it in your shell.'));
    }
    
    const lightModelAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'lightModel',
        message: `Select lightweight ${answers.provider} model for simple queries:`,
        choices: lightModelChoices[answers.provider],
        default: config.lightModels[answers.provider]
      }
    ]);
    
    config.lightModels[answers.provider] = lightModelAnswer.lightModel;
  }
  
  // Ask about reasoning mode
  const reasoningAnswers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'reasoningEnabled',
      message: 'Enable reasoning mode for complex problems?',
      default: config.reasoningMode.enabled
    }
  ]);
  
  config.reasoningMode.enabled = reasoningAnswers.reasoningEnabled;
  
  // Configure reasoning mode settings if enabled
  if (reasoningAnswers.reasoningEnabled) {
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
    
    config.reasoningMode.iterations = parseInt(reasoningModeAnswers.iterations);
    config.reasoningMode.showIntermediate = reasoningModeAnswers.showIntermediate;
  }
  
  // If file/terminal agent is enabled, configure agent settings
  if (answers.agentEnabled) {
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
      },
      {
        type: 'input',
        name: 'newDisallowedCommand',
        message: 'Add disallowed command (leave empty to skip):',
        default: ''
      }
    ]);
    
    // Update agent configuration
    config.agent.useVirtualEnvironment = agentAnswers.useVirtualEnvironment;
    config.agent.allowedDirectories = agentAnswers.allowedDirectories;
    
    // Add new disallowed command if provided
    if (agentAnswers.newDisallowedCommand) {
      config.agent.disallowedCommands.push(agentAnswers.newDisallowedCommand);
    }
  }
  
  // Save configuration
  if (saveConfig()) {
    console.log(chalk.green('✓ Configuration saved successfully'));
  }
  
  // Provider-specific main model selection
  const modelChoices = {
    openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    anthropic: ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20240620', 'claude-3-opus-20240229'],
    google: ['gemini-2.0-flash']
  };
  
  // Check API keys for the selected provider again before model selection
  if (answers.provider === 'openai' && !process.env.OPENAI_API_KEY) {
    console.log(chalk.red('Warning: OPENAI_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('You will need to set the OPENAI_API_KEY environment variable to use OpenAI.'));
  } else if (answers.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.log(chalk.red('Warning: ANTHROPIC_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('You will need to set the ANTHROPIC_API_KEY environment variable to use Anthropic Claude.'));
  } else if (answers.provider === 'google' && !process.env.GOOGLE_API_KEY) {
    console.log(chalk.red('Warning: GOOGLE_API_KEY environment variable is not set.'));
    console.log(chalk.yellow('You will need to set the GOOGLE_API_KEY environment variable to use Google AI.'));
  }
  
  const modelAnswer = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: `Select main ${answers.provider} model for complex queries:`,
      choices: modelChoices[answers.provider],
      default: config.models[answers.provider]
    }
  ]);
  
  // Update and save model configuration
  config.models[answers.provider] = modelAnswer.model;
  saveConfig();
  
  console.log(chalk.green(`✓ Now using ${chalk.bold(answers.provider)} with model ${chalk.bold(modelAnswer.model)}`));
  
  if (config.agentMode.enabled) {
    console.log(chalk.green(`✓ Agent mode enabled with ${chalk.bold(config.lightModels[answers.provider])} for simple queries`));
    console.log(chalk.green(`✓ Routing threshold set to ${chalk.bold(config.agentMode.routingThreshold)}`));
  }
}

// Interactive chat mode
async function startChatMode() {
  displayLogo();
  
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
  }
  
  console.log(chalk.cyan(`Current provider: ${chalk.bold(config.currentProvider)}`));
  
  // Show different model info based on agent mode
  if (config.agentMode.enabled) {
    console.log(chalk.cyan(`Models: ${chalk.bold(config.models[config.currentProvider])} (complex) / ${chalk.bold(config.lightModels[config.currentProvider])} (simple)`));
  } else {
    console.log(chalk.cyan(`Current model: ${chalk.bold(config.models[config.currentProvider])}`));
  }
  
  // Show reasoning mode status if enabled
  if (config.reasoningMode.enabled) {
    console.log(chalk.magenta(`Reasoning Mode: Enabled (${config.reasoningMode.iterations} iterations)`));
  }
  
  console.log(chalk.yellow('Type "/help" for available commands, "/exit", "/quit", or "/end" to quit'));
  
  // Show agent commands if enabled
  if (config.agent.enabled) {
    console.log(chalk.yellow('Agent commands: "/fs" for file operations, "/exec" for terminal commands'));
  }
  
  console.log(chalk.yellow('Use \\ at the end of line + Enter for multi-line input'));
  console.log(chalk.yellow('Press Enter on an empty line to submit your question\n'));
  
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
            escapeCodeTimeout: 50
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
        
        // Detect pasting by measuring timestamp difference between keypresses
        const now = Date.now();
        
        // If rapid succession of characters, likely a paste operation
        if (now - startTime < 5 && char && !key && !isPasting) {
          isPasting = true;
          pastedText = rl.line;
          
          // Check for embedded newlines by looking ahead a few characters
          if (pastedText.includes('\n')) {
            // Process will happen after input is received
            console.log(chalk.gray('Detected multiline paste...'));
          }
        }
        
        startTime = now;
        
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
            rl._refreshLine();
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
            rl._refreshLine();
          }
        }
      });
      
      // Wait for the prompt to complete
      const { userInput } = await prompt;
      
      // Process potential multiline paste
      if (userInput.includes('\n')) {
        // Split by newlines and process each line
        const lines = userInput.split('\n');
        
        // Add all lines to multilineInput
        multilineInput += lines.join('\n');
        
        // Signal end of input
        continueInput = false;
      }
      // Check if input is empty and we already have some input - submit the question
      else if (userInput === '' && multilineInput !== '') {
        continueInput = false;
      }
      // Check if input ends with backslash to continue to next line
      else if (userInput.endsWith('\\')) {
        multilineInput += userInput.slice(0, -1) + '\n';
      } 
      // Otherwise add the input and finish if not empty
      else if (userInput !== '') {
        multilineInput += userInput;
        continueInput = false;
      }
      // Empty input with no existing input - just continue
      else {
        continue;
      }
      
      // Remove event listeners to prevent duplicates in next iteration
      rl.input.removeAllListeners('keypress');
      rl.removeAllListeners('line');
      rl.removeAllListeners('SIGINT');
    }
    
    const question = multilineInput.trim();
    
    // Handle special commands with forward slash
    if (question.toLowerCase() === '/exit' || question.toLowerCase() === '/quit' || question.toLowerCase() === '/end') {
      console.log(chalk.yellow('Goodbye!'));
      break;
    } else if (question.toLowerCase() === '/clear') {
      // Check if this is a request to clear context or screen
      messageHistory = [];
      console.clear();
      displayLogo();
      console.log(chalk.yellow('Terminal and context cleared!'));
      continue;
    } else if (question.toLowerCase() === '/clearscreen' || question.toLowerCase() === '/cls') {
      // Clear just the screen
      console.clear();
      displayLogo();
      console.log(chalk.yellow('Terminal screen cleared!'));
      continue;
    } else if (question.toLowerCase() === '/help') {
      // Display help information
      console.log(chalk.cyan('Available Commands:'));
      console.log(chalk.yellow('- /exit, /quit, or /end - Quit the application'));
      console.log(chalk.yellow('- /clear - Clear conversation history and terminal screen'));
      console.log(chalk.yellow('- /cls or /clearscreen - Clear only the terminal screen'));
      console.log(chalk.yellow('- /menu - Access settings menu'));
      console.log(chalk.yellow('- /help - Display this help information'));
      console.log(chalk.yellow('- /d question - Send question directly to the powerful model (bypass routing)'));
      
      if (config.agent.enabled) {
        console.log(chalk.cyan('\nAgent Commands (when enabled):'));
        console.log(chalk.yellow('- /fs operation:path[:content] - File operations'));
        console.log(chalk.yellow('  Operations: read, write, list, exists'));
        console.log(chalk.yellow('- /exec command - Execute terminal commands'));
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
      console.log(chalk.yellow('- Type /p to enter multiline paste mode'));
      continue;
    } else if (question.toLowerCase() === '/paste' || question.toLowerCase() === '/p') {
      // Special paste mode that captures multiline input
      console.log(chalk.cyan('Paste Mode: Paste your multiline text and press Ctrl+D when finished'));
      
      // Setup a raw input stream to capture multiline paste
      const inputChunks = [];
      
      // Create a promise to handle the paste operation
      const pastePromise = new Promise((resolve) => {
        // Set raw mode to capture input directly
        process.stdin.setRawMode(false);
        
        // Listen for data events
        process.stdin.on('data', (chunk) => {
          inputChunks.push(chunk);
        });
        
        // When stdin ends (Ctrl+D), process the input
        process.stdin.once('end', () => {
          // Reset stdin to normal mode
          process.stdin.setRawMode(true);
          
          // Combine all chunks and resolve the promise
          const pastedText = Buffer.concat(inputChunks).toString();
          resolve(pastedText);
          
          // Resume stdin to continue program
          process.stdin.resume();
        });
      });
      
      try {
        // Wait for paste to complete
        const pastedText = await pastePromise;
        
        // Process the pasted text
        if (pastedText.trim()) {
          // Add to message history
          messageHistory.push({ role: 'user', content: pastedText.trim() });
          
          // Display formatted user message
          console.log(formatUserMessage(pastedText.trim()));
          
          // Get AI response
          const response = await askAI(pastedText.trim());
          
          // Add to input history if it's not a command
          if (!pastedText.trim().startsWith('/') && !inputHistory.includes(pastedText.trim())) {
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
      } finally {
        // Make sure stdin is set back to normal mode and resumed
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }
      
      continue;
    } else if (question.toLowerCase() === '/menu') {
      await configureSettings();
      continue;
    } else if (question.toLowerCase().startsWith('/d ')) {
      // Direct to powerful model command
      const directQuestion = question.slice(3).trim();
      
      if (!directQuestion) {
        console.log(chalk.red('Please provide a question after /d'));
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
    } else if (question.toLowerCase().startsWith('/fs ') && config.agent.enabled) {
      // Process file system command via direct command
      const command = question.slice(4);
      const parts = command.split(':');
      
      if (parts.length < 2) {
        console.log(chalk.red('Invalid file system command format. Use operation:path[:content]'));
        continue;
      }
      
      const operation = parts[0].trim();
      // Set base directory to /Users/leland/Documents/
      let filePath = parts[1].trim();
      if (!filePath.startsWith('/Users/leland/Documents')) {
        filePath = path.join('/Users/leland/Documents', filePath);
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
    } else if (question.toLowerCase().startsWith('/exec ') && config.agent.enabled) {
      // Process terminal execution command
      const command = question.slice(6);
      
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
    }
  }
}

// Main CLI configuration
program
  .name('qa')
  .description('QA - Terminal AI Assistant')
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
  .description('Configure AI providers and models')
  .action(async () => {
    loadConfig();
    await configureSettings();
  });

// Parse command line arguments
program.parse(process.argv);
