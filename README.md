# QA - AI Terminal Assistant

A beautiful terminal application for interacting with multiple AI models (OpenAI GPT-4o, Anthropic Claude 3.7 Sonnet, and Google Gemini Flash 2.0) with context memory support.

## Features

- 🤖 Support for multiple AI providers (OpenAI, Anthropic, Google)
- 💬 Conversation context/memory within a session
- 🎨 Beautiful terminal UI with colors and formatting
- ⚙️ Easy configuration via interactive menus
- 🔒 Secure API key management via environment variables
- 🧠 Agent capabilities for file system and terminal access (with safety controls)

## Installation

1. Clone this repository or create the files as shown:
   - `index.js` - Main application file
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
- Special commands (all commands now begin with a forward slash):
  - `/exit`: Quit the application
  - `/clear`: Clear conversation history and terminal screen
  - `/clearscreen`: Clear only the terminal screen
  - `/menu`: Access settings menu
  - `/fs operation:path[:content]`: File system operations (when agent is enabled)
  - `/exec command`: Execute terminal commands (when agent is enabled)
- Use backslash (\\) at the end of a line followed by Enter/Return to continue input on a new line

### Agent Capabilities

When enabled, the AI can interact with your file system and terminal:

- **File System Operations**:
  - `read`: Read file contents (`/fs read:/path/to/file.txt`)
  - `write`: Write content to a file (`/fs write:/path/to/file.txt:content`)
  - `list`: List directory contents (`/fs list:/path/to/directory`)
  - `exists`: Check if a file exists (`/fs exists:/path/to/file.txt`)

- **Terminal Execution**:
  - Execute shell commands (`/exec ls -la`)
  - Optionally run in a virtual environment using Docker (configurable)

- **Safety Features**:
  - Permission confirmation before any operation
  - Directory access restrictions
  - Disallowed command patterns
  - Virtual environment option

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

## Supported Models

### OpenAI
- gpt-4o (default)
- gpt-4-turbo
- gpt-3.5-turbo

### Anthropic
- claude-3-7-sonnet-20250219 (default)
- claude-3-5-sonnet-20240620
- claude-3-opus-20240229

### Google
- gemini-1.5-flash-latest (default)
- gemini-1.5-pro-latest
