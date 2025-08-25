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
- 🔎 Automatic local project scan: for queries like “what can you tell me about X in this app?”, QAterm non-destructively scans your repo (README, entrypoints, grep for keywords) and summarizes findings before calling an AI

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
- You can start the app quietly with `--qs` (or `--quiet-start`) to suppress the banner and startup text; it will print `<Connected>`
- Special commands (all commands now begin with a backslash):
  - `\exit`: Quit the application
  - `\clear`: Clear conversation history and terminal screen
  - `\cls` or `\clearscreen`: Clear only the terminal screen
  - `\menu`: Access settings menu
  - `\help`: Display available commands and information
  - `\visual` or `\v`: Open visual tri‑pane (files | chat | preview). Inside: press `V` to toggle tri‑pane, `C` to ask AI
  - `\d question`: Send question directly to the powerful model (bypass routing)
  - `\direct` or `\dr`: Toggle direct mode (always use powerful model)
  - `\directfast` or `\df`: Toggle fast direct mode (powerful model with reasoning disabled)
  - `\fs operation:path[:content]`: File system operations (when agent is enabled)
  - `\exec command`: Execute terminal commands (when agent is enabled)
  - `\copy` or `\copy-last`: Copy last AI response to clipboard
  - `\copy-all` or `\copy-session`: Copy entire session transcript to clipboard
  - `\image <filepath>` or `\image`: Upload and analyze images (supports JPG, PNG, GIF, WebP, BMP, TIFF)
- `\upload <filepath>` or `\upload`: Upload and analyze images (alias for \image)
- `\img <filepath>` or `\img`: Upload and analyze images (alias for \image)
- `\images <filepath>` or `\images`: Upload and analyze multiple images
- `\uploads <filepath>` or `\uploads`: Upload and analyze multiple images (alias for \images)
- `\file <filepath>` or `\file`: Upload and analyze any supported file type
- `\files <filepath>` or `\files`: Upload and analyze multiple files

Supported models include latest OpenAI options (e.g., `gpt-5`). Use `\menu` to select provider and model interactively.
  
#### Coding Mode Commands
  - `\compact`: Summarize the current conversation to preserve context
  - `\feature <description>`: Add a new feature to the project context file
  - `\clear`: Clear conversation history and current.md file
  
#### Agentic Mode Commands
  - `\agentic` or `\schedule`: Toggle agentic mode on/off
  - Prefix a query with `\a` (or `\agent`, `\agentic`) to run that single query using agentic multi-agent execution
  - `\task <description>`: Create a new task with parallel agents
  - `\smart-conductor`: Toggle using a powerful model as task conductor
  - `\continue`: Grant permission to agents to continue working
  - `\cancel-task`: Cancel the current task
  - `\status`: Show detailed task status and agent progress

- Input features:
  - Use up/down arrow keys to navigate through input history
  - Use backslash (\\) at the end of a line followed by Enter/Return to continue input on a new line
  - Press Enter on an empty line to submit multi-line input
  - Type `\p` to enter paste mode for multiline pasting (finish with `\\end` on a new line; Windows: `Ctrl+Z` then Enter)
  - Multiline pasting is detected automatically when your terminal supports bracketed paste

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
  - Auto‑approval (safe): When enabled, non‑destructive FS ops (`read`, `list`, `exists`) can be auto‑approved. In Visual mode, safe ops suggested by the AI are executed silently and results are rendered in the Chat pane.

### Keybindings (Vim-like)
QAterm features a Vim-like keybinding system with a prefix key (`Ctrl+S`) for quick access to common commands. The system uses a **hybrid approach** with both toggle modes and execute commands.

#### Hybrid Mode System
**Toggle Modes (Persistent):**
- `Ctrl+S` + `a`: Toggle agentic mode ON/OFF
- `Ctrl+S` + `v`: Toggle visual tri-pane mode ON/OFF  
- `Ctrl+S` + `p`: Toggle paste mode ON/OFF

**Execute Commands (One-time):**
- `Ctrl+S` + `f`: Execute file explorer/selector for any file type
- `Ctrl+S` + `n`: Execute directory navigation
- `Ctrl+S` + `:`: Execute terminal command
- `Ctrl+S` + `h`: Execute help information
- `Ctrl+S` + `m`: Execute settings menu
- `Ctrl+S` + `c`: Execute clear conversation history
- `Ctrl+S` + `t`: Execute TUI file browser
- `Ctrl+S` + `d`: Execute direct model query
- `Ctrl+S` + `r`: Execute project review
- `Ctrl+S` + `s`: Execute system status
- `Ctrl+S` + `w`: Execute file write operation
- `Ctrl+S` + `l`: Execute directory listing
- `Ctrl+S` + `g`: Execute grep search

#### Mode Behaviour
- **Toggle modes** persist until toggled off again
- **Execute commands** run once and return to normal mode
- Current mode is displayed in the interface
- Mode states are tracked independently

#### Configuration
Keybindings can be customized in `keybindings.json`. The system supports:
- Custom prefix key
- Remappable key combinations
- Command aliases
- Mode settings (toggle vs execute)
- Timeout settings

### File Upload and Analysis
QAterm supports uploading and analyzing various file types with AI providers that have vision capabilities.

#### Supported File Types
- **Images**: JPG, PNG, GIF, WebP, BMP, TIFF, SVG
- **Documents**: PDF, DOC, DOCX, TXT, MD, RTF, ODT
- **Spreadsheets**: CSV, XLS, XLSX, ODS
- **Code**: JS, TS, PY, Java, C++, C, PHP, Ruby, Go, Rust, Swift, Kotlin, Scala, Clojure, Haskell, ML, F#, VB, C#, SQL, Shell scripts
- **Data**: JSON, XML, YAML, TOML, INI, CFG, CONF
- **Archives**: ZIP, TAR, GZ, BZ2, 7Z, RAR
- **Web**: HTML, CSS, SCSS, SASS, LESS, JSX, TSX, Vue, Svelte
- **Config**: ENV, GitIgnore, Dockerfile, EditorConfig
- **Logs**: LOG, OUT, ERR

#### Usage Methods
- Direct file path: `\file ./document.pdf "What do you see in this document?"`
- Interactive browser: `\file` (then browse and select)
- Multiple file selection: `\files` (then browse and select multiple)
- Clipboard paste: `\upload` (then paste file path)

#### AI Provider Support
- OpenAI GPT-4o (vision)
- Anthropic Claude 3.5 Sonnet (vision)
- Google Gemini 2.0 Flash (vision)
- OpenRouter DeepSeek Vision

#### Features
- Telescope-like file browser with file type icons
- Multiple file selection with visual indicators
- Base64 encoding for all providers
- File size and format validation
- Multiple command aliases (`\file`, `\files`, `\upload`, `\uploads`)

### Image Upload and Analysis
- **Supported Formats**: JPG, PNG, GIF, WebP, BMP, TIFF
- **Usage Methods**:
  - Direct file path: `\image ./screenshot.png "What do you see in this image?"`
  - Interactive browser: `\image` (then browse and select)
  - Multiple image selection: `\images` (then browse and select multiple)
  - Clipboard paste: `\upload` (then paste file path)
- **AI Provider Support**:
  - OpenAI GPT-4o (vision)
  - Anthropic Claude 3.5 Sonnet (vision)
  - Google Gemini 2.0 Flash (vision)
  - OpenRouter DeepSeek Vision
- **Features**:
  - Telescope-like file browser for image selection
  - Multiple image selection with visual indicators
  - Base64 encoding for all providers
  - File size and format validation
  - Multiple command aliases (`\image`, `\upload`, `\img`, `\images`, `\uploads`)

### Automatic Local Scan (Non-destructive)
- What it does: When you ask about a feature in “this app/project” (e.g., “what can you tell me about the fzf feature in this app?”), QAterm will:
  - Detect if you’re inside a project
  - Inspect docs and entrypoints (README.md, HELP.txt, index.js, package.json main)
  - Run a safe grep across the repo (excluding node_modules/.git) to find references
  - Return snippets grouped by file, without modifying anything
- Toggle: Enabled by default via `autoActions.localSearchBeforeAI` in `config.json`.
- Tip: Use `\review .` for a deeper parallel analysis if grep returns little.

### Visual Mode (Tri‑pane)
Open with `\visual` (alias `\v`).

- Layout: Files (left), Preview (middle; wrapped), Chat (right; wrapped)
- Controls:
  - `Tab`/`Shift+Tab`: Cycle focus (Files → Preview → Chat)
  - `C`: Ask AI (inline prompt inside Chat pane; Esc cancels). The selected file’s path and a short preview are included automatically so you can talk about it immediately
  - `V`: Toggle three‑pane layout on/off
  - `S`: Toggle Auto‑scan (toast shown; saved to config)
  - `PgUp`/`PgDn`, `↑`/`↓`: Scroll Chat/Preview when focused
- Notes:
  - Startup banner shows a status row: Auto‑scan, Agentic, Provider
  - Auto‑scan runs only for questions explicitly scoped to “this app/project/repo/codebase/directory” or when you say “review”

#### Edit View (single file)
- From Visual mode, select a file and press `E` to open the editor view.
- Layout: Editor (left; Vim‑like) and AI Chat (right).
- Modes and keys:
  - Normal: `h/j/k/l` move, `i` insert, `o` open line below, `G` end, `:w` save, `:q` quit, `:wq` save+quit
  - Insert: type to edit, Enter to split line, Backspace to merge/delete, `Esc` returns to Normal
  - Paging: `Ctrl‑f`/`Ctrl‑b` page down/up
  - Help: `?` toggles a contextual help bar with the most useful keys for the current mode
- AI collaboration:
  - Press `C` to enter an instruction for the AI (e.g., “convert var to const and fix lint”).
  - The AI previews changes by sending a full file update; the buffer updates immediately. Save with `:w` to write.
  - Safe FS ops (read/list/exists) from the AI are auto‑approved; destructive changes still require saving.

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
- gemini-2.5-pro (default for complex queries)
- gemini-2.5-flash-lite (default for simple queries in agent mode)

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
