# QAterm Project Information

## Project Overview
QAterm is a terminal-based AI assistant that connects to multiple AI providers (OpenAI, Anthropic, Google) with conversation context/memory support.

## Commands

### Running the Application
```bash
npm start
```

### Global Usage (if installed globally)
```bash
qa
```

### Settings Configuration
```bash
qa settings
```

### In Chat Mode
- Type "/exit" to quit
- Type "/clear" to clear conversation history and terminal screen
- Type "/clearscreen" to clear only the terminal screen
- Type "/menu" to access settings menu
- Type "/fs operation:path[:content]" for file operations (if agent enabled)
- Type "/exec command" for terminal commands (if agent enabled)
- Use backslash (\) at the end of a line followed by Enter/Return to continue input on a new line

### Agent Commands
- File operations: read, write, list, exists
  - `/fs read:/path/to/file.txt`
  - `/fs write:/path/to/file.txt:content`
  - `/fs list:/path/to/directory`
  - `/fs exists:/path/to/file.txt`
- Terminal execution: 
  - `/exec ls -la`

## Code Structure
- `index.js` - Main application file containing all logic
- `config.json` - Stores configuration settings
- `package.json` - Dependencies and project metadata

## AI Providers and Models
- OpenAI: gpt-4o, gpt-4-turbo, gpt-3.5-turbo
- Anthropic: claude-3-7-sonnet-20250219, claude-3-5-sonnet-20240620, claude-3-opus-20240229
- Google: gemini-2.0-flash

## Dependencies
- @anthropic-ai/sdk: Anthropic Claude API client
- @google/generative-ai: Google Gemini API client
- openai: OpenAI API client
- chalk, boxen, figlet, gradient-string: Terminal styling
- inquirer: Interactive prompts
- commander: CLI framework
- dotenv: Environment variable management
- ora: Terminal spinners

## Environment Variables Required
- OPENAI_API_KEY
- ANTHROPIC_API_KEY
- GOOGLE_API_KEY