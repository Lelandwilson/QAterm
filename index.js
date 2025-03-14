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
  maxContextMessages: 10, // Default context window size
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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

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
  const filePath = path.resolve(params.path);
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
    
    exec(command, { cwd: process.cwd() }, (error, stdout, stderr) => {
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
    
    // Create a context-aware history format for each provider
    switch (config.currentProvider) {
      case 'openai':
        const openaiMessages = [
          {
            role: 'system',
            content: `You are a helpful AI assistant in a terminal environment. ${agentInstructions}`
          },
          ...messageHistory.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          }))
        ];
        
        const openaiResponse = await openai.chat.completions.create({
          model: config.models.openai,
          messages: openaiMessages,
          temperature: 0.7,
        });
        
        response = openaiResponse.choices[0].message.content;
        break;
        
      case 'anthropic':
        // Format messages for Anthropic
        const anthropicMessages = [
          {
            role: 'system',
            content: `You are a helpful AI assistant in a terminal environment. ${agentInstructions}`
          },
          ...messageHistory.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          }))
        ];
        
        const anthropicResponse = await anthropic.messages.create({
          model: config.models.anthropic,
          messages: anthropicMessages,
          max_tokens: 1024,
          temperature: 0.7,
        });
        
        response = anthropicResponse.content[0].text;
        break;
        
      case 'google':
        // Format messages for Google
        const systemPrompt = `You are a helpful AI assistant in a terminal environment. ${agentInstructions}\n\n`;
        
        const googleMessages = [
          systemPrompt,
          ...messageHistory.map(msg => 
            `${msg.role === 'user' ? 'User: ' : 'Assistant: '}${msg.content}`
          )
        ].join('\n\n');
        
        const googleModel = genAI.getGenerativeModel({ model: config.models.google });
        const googleResponse = await googleModel.generateContent(googleMessages);
        
        response = googleResponse.response.text();
        break;
        
      default:
        throw new Error('Unknown provider');
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
      name: 'agentEnabled',
      message: 'Enable agent capabilities (file system & terminal access)?',
      default: config.agent.enabled
    }
  ]);
  
  // Update configuration
  config.currentProvider = answers.provider;
  config.maxContextMessages = parseInt(answers.contextSize);
  config.agent.enabled = answers.agentEnabled;
  
  // If agent is enabled, configure agent settings
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
  
  // Provider-specific model selection
  const modelChoices = {
    openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    anthropic: ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20240620', 'claude-3-opus-20240229'],
    google: ['gemini-2.0-flash']
  };
  
  const modelAnswer = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: `Select ${answers.provider} model:`,
      choices: modelChoices[answers.provider],
      default: config.models[answers.provider]
    }
  ]);
  
  // Update and save model configuration
  config.models[answers.provider] = modelAnswer.model;
  saveConfig();
  
  console.log(chalk.green(`✓ Now using ${chalk.bold(answers.provider)} with model ${chalk.bold(modelAnswer.model)}`));
}

// Interactive chat mode
async function startChatMode() {
  displayLogo();
  console.log(chalk.cyan(`Current provider: ${chalk.bold(config.currentProvider)}`));
  console.log(chalk.cyan(`Current model: ${chalk.bold(config.models[config.currentProvider])}`));
  console.log(chalk.yellow('Type "/help" for available commands, "/exit" to quit'));
  
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
      rl.input.on('keypress', (_, key) => {
        if (!key) return;
        
        // Handle up arrow key - navigate backward in history
        if (key.name === 'up') {
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
        else if (key.name === 'down') {
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
      
      // Check if input is empty and we already have some input - submit the question
      if (userInput === '' && multilineInput !== '') {
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
    if (question.toLowerCase() === '/exit') {
      console.log(chalk.yellow('Goodbye!'));
      break;
    } else if (question.toLowerCase() === '/clear') {
      // Check if this is a request to clear context or screen
      messageHistory = [];
      console.clear();
      displayLogo();
      console.log(chalk.yellow('Terminal and context cleared!'));
      continue;
    } else if (question.toLowerCase() === '/clearscreen') {
      // Clear just the screen
      console.clear();
      displayLogo();
      console.log(chalk.yellow('Terminal screen cleared!'));
      continue;
    } else if (question.toLowerCase() === '/help') {
      // Display help information
      console.log(chalk.cyan('Available Commands:'));
      console.log(chalk.yellow('- /exit - Quit the application'));
      console.log(chalk.yellow('- /clear - Clear conversation history and terminal screen'));
      console.log(chalk.yellow('- /clearscreen - Clear only the terminal screen'));
      console.log(chalk.yellow('- /menu - Access settings menu'));
      console.log(chalk.yellow('- /help - Display this help information'));
      
      if (config.agent.enabled) {
        console.log(chalk.cyan('\nAgent Commands (when enabled):'));
        console.log(chalk.yellow('- /fs operation:path[:content] - File operations'));
        console.log(chalk.yellow('  Operations: read, write, list, exists'));
        console.log(chalk.yellow('- /exec command - Execute terminal commands'));
      }
      
      console.log(chalk.cyan('\nInput Methods:'));
      console.log(chalk.yellow('- Use \\ at end of line + Enter for multi-line input'));
      console.log(chalk.yellow('- Press Enter on empty line to submit your question'));
      continue;
    } else if (question.toLowerCase() === '/menu') {
      await configureSettings();
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
      const filePath = parts[1].trim();
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
            const filePath = parts[1].trim();
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
