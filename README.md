# QA - AI Terminal Assistant

A beautiful terminal application for interacting with multiple AI models (OpenAI GPT-4o, Anthropic Claude 3.7 Sonnet, Google Gemini Flash 2.0, and DeepSeek via OpenRouter) with context memory support, project-specific coding assistance, and multi-threaded agent orchestration.

## Features

- 🤖 Support for multiple AI providers (OpenAI, Anthropic, Google, OpenRouter)
- 💬 Conversation context/memory within a session
- 🎨 Beautiful terminal UI with colors and formatting
- ⚙️ Easy configuration via interactive menus
- 🔒 Secure API key management via environment variables
- 🧠 Agent capabilities for file system and terminal access (with safety controls)
- 🔍 Agent mode with automatic query classification to optimize model usage
- 🧩 Reasoning mode for complex problems with iterative self-improvement
- 💻 Coding mode with project-specific context management and conversation summarization
- 🚀 Agentic mode with multi-threaded parallel task execution and conductor-worker architecture

## Installation

1. Clone this repository or create the files as shown:
   - `index.js` - Main application file
   - `worker.js` - Worker thread implementation for parallel agents
   - `package.json` - Dependencies and metadata
   - `.env` - Environment variables for API keys
   - `config.json` - Application configuration

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your API keys by creating a `.env` file:
   ```bash
   cp .env.template .env
   ```
   Then edit the `.env` file with your actual API keys.

4. Make the script executable:
   ```bash
   chmod +x index.js
   ```

## Usage

Start the application:
```bash
npm start
```

Or use it directly if installed globally:
```bash
qa
```

### Commands

- **Default:** Interactive chat mode
- **settings:** Configure AI providers and models
  ```bash
  qa settings
  ```

### In Chat Mode

- Type your questions and get AI responses
- Special commands (all commands now begin with a backslash):
  - `\exit`: Quit the application
  - `\clear`: Clear conversation history and terminal screen
  - `\cls` or `\clearscreen`: Clear only the terminal screen
  - `\menu`: Access settings menu
  - `\help`: Display available commands and information
  - `\d question`: Send question directly to the powerful model (bypass routing)
  - `\direct` or `\dr`: Toggle direct mode (always use powerful model)
  - `\directfast` or `\df`: Toggle fast direct mode (powerful model with reasoning disabled)
  - `\fs operation:path[:content]`: File system operations (when agent is enabled)
  - `\exec command`: Execute terminal commands (when agent is enabled)
  
#### Coding Mode Commands
  - `\compact`: Summarize the current conversation to preserve context
  - `\feature <description>`: Add a new feature to the project context file
  - `\clear`: Clear conversation history and current.md file
  
#### Agentic Mode Commands
  - `\agentic` or `\schedule`: Toggle agentic mode on/off
  - `\task <description>`: Create a new task with parallel agents
  - `\smart-conductor`: Toggle using a powerful model as task conductor
  - `\continue`: Grant permission to agents to continue working
  - `\cancel-task`: Cancel the current task
  - `\status`: Show detailed task status and agent progress

- Input features:
  - Use up/down arrow keys to navigate through input history
  - Use backslash (\\) at the end of a line followed by Enter/Return to continue input on a new line
  - Press Enter on an empty line to submit multi-line input
  - Type `\p` to enter paste mode for multiline pasting (finish with Ctrl+D)
  - Multiline pasting is detected automatically for convenience

### Agent Capabilities

When enabled, the AI can interact with your file system and terminal:

- **File System Operations**:
  - `read`: Read file contents (`\fs read:/path/to/file.txt`)
  - `write`: Write content to a file (`\fs write:/path/to/file.txt:content`)
  - `list`: List directory contents (`\fs list:/path/to/directory`)
  - `exists`: Check if a file exists (`\fs exists:/path/to/file.txt`)

- **Terminal Execution**:
  - Execute shell commands (`\exec ls -la`)
  - Optionally run in a virtual environment using Docker (configurable)

- **Safety Features**:
  - Permission confirmation before file write operations
  - Disallowed command patterns for terminal execution
  - Virtual environment option for sandboxed execution
  - Uses current working directory by default

## Global Installation

To install the application globally, run:
```bash
npm install -g .
```

Then you can use the `qa` command from anywhere.

## Configuration

The application stores configuration in `config.json`. You can:
- Change the default AI provider
- Select specific models for each provider
- Adjust the context window size
- Configure agent, agent mode, and reasoning mode settings

## Special Modes

### Agent Mode
When enabled, this mode automatically:
- Analyzes each query's complexity using a lightweight model
- Routes simple queries to lightweight models (faster, cheaper)
- Routes complex queries to powerful models (better quality)
- Shows you which model was used for each response

### Reasoning Mode
When enabled, this mode:
- Applies iterative self-improvement to solve complex problems
- Breaks down problems into manageable parts
- Goes through multiple reasoning steps to refine the answer
- Can show intermediate reasoning steps if configured
- Works best with complex, multi-step problems

### Coding Mode
When enabled, this mode provides enhanced project-specific assistance:
- Creates and maintains an `ai.md` file with important project information
- Stores and manages the current conversation in `current.md`
- Allows compacting/summarizing conversation history to preserve context
- Tracks features and project-specific knowledge
- Automatically suggests creating tasks when working on complex coding problems
- Uses expanded context window for better code assistance

### Agentic Mode
When enabled, this powerful mode provides true multi-agent orchestration:
- Launches a conductor agent to plan and coordinate complex tasks
- Dynamically creates worker agents specialized for different aspects of the task
- Executes agent actions in parallel using separate worker threads
- Coordinates information sharing between agents according to a workflow
- Manages agent permissions and action limits
- Synthesizes results from all agents into a coherent final response
- Supports various task types: research, coding, analysis, filesystem, and automation
- Provides real-time status tracking of all running agents
- Allows cancelling tasks or granting additional permissions
- Offers smart vs. lightweight conductor options for different tasks

## Supported Models

### OpenAI
- gpt-4o (default for complex queries)
- gpt-4-turbo
- gpt-3.5-turbo (default for simple queries in agent mode)

### Anthropic
- claude-3-7-sonnet-20250219 (default for complex queries)
- claude-3-5-sonnet-20240620
- claude-3-opus-20240229
- claude-3-haiku-20240307 (default for simple queries in agent mode)

### Google
- gemini-2.0-flash (default for complex queries)
- gemini-2.0-flash-lite (default for simple queries in agent mode)

### OpenRouter
- deepseek/deepseek-v2 (default for complex queries)
- deepseek/deepseek-v1 (default for simple queries in agent mode)

## Dependencies
- @anthropic-ai/sdk: Anthropic Claude API client
- @google/generative-ai: Google Gemini API client
- openai: OpenAI API client
- chalk, boxen, figlet, gradient-string: Terminal styling
- inquirer: Interactive prompts
- commander: CLI framework
- dotenv: Environment variable management
- ora: Terminal spinners
- uuid: Unique ID generation for tasks and agents
- worker_threads: Node.js built-in module for parallel execution

## Environment Variables Required
- OPENAI_API_KEY
- ANTHROPIC_API_KEY
- GOOGLE_API_KEY
- OPENROUTER_API_KEY
