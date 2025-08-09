# QAterm User Guide

This guide covers day-to-day usage of QAterm: chat, paste, agentic tasks, natural-language execution, and the built-in TUI file browser with search and AI integrations.

## Launching

- Normal: `qa` (or `node index.js`)
- Quiet start: `qa --qs` (or `--quiet-start`) prints only `<Connected>` and suppresses banners.

## Prompt Basics

- The prompt shows the current working directory like a shell, e.g. `~/project >`.
- Multi-line input:
  - End a line with `\` and press Enter to continue the next line. Enter on a blank line submits.
- Paste:
  - Type `\p` to enter paste mode. Finish with `\end` or `/end` on a new line. Windows: Ctrl+Z then Enter.
  - Bracketed paste is auto-detected in many terminals; “Captured paste (N lines)” will be shown.

## Core Chat Commands (backslash syntax)

- `\help`: Show help
- `\menu`: Settings menu for providers/models/modes
- `\exit`: Quit
- `\clear` / `\cls`: Clear context / just the screen
- `\copy`, `\copy-last`: Copy last AI response
- `\copy-all`, `\copy-session`: Copy entire session transcript
- `\d <question>`: Send directly to powerful model
- `\a <question>`: Run this single query with agentic multi-agent mode
- `\tui`: Launch the interactive TUI (file browser + search)

## Agentic and Exec

- Per-query agentic: Prefix with `\a` (also `\agent`, `\agentic`).
- Auto-approve exec: Non-destructive exec commands run without confirmation (configurable).
  - Destructive operations (delete/remove) require typing `DELETE`.
- Quick approval: Reply `y/yes/ok/sure/do it` to run commands shown in the last assistant message (agent or code blocks), no extra confirm (non-destructive).

## Natural-Language Exec (\e / \exec)

Write what you want, QAterm translates to safe cross‑platform commands:

- Directories & files:
  - `make a new directory ~/Documents/testabc` → `mkdir -p "…"`
  - `create file notes.txt` → `touch "notes.txt"`
  - `list files in ./src` → `ls -la "./src"`
  - `show file README.md` → `sed -n '1,200p' "README.md"`
- Copy/move:
  - `copy a.txt b.txt to dest/` (multi-source)
  - `copy folder ./src to ./backup`
  - `move app.js to app.old.js`
- Open:
  - `open ~/Downloads` (Finder/Explorer/xdg-open)
  - `open in code ./project` (VS Code)
- Archives:
  - `zip ./project to proj.zip`
  - `zip ./project without node_modules and .git` (best-effort; exclusions not applied on Windows)
  - `unzip archive.zip to ./dest`
- Find/Replace:
  - `find files matching *.md in ./docs`
  - `replace 'foo' with 'bar' in file a.txt`
  - `replace 'foo' with 'bar' in files matching *.js under ./src`
- Force delete (guarded):
  - `force delete ./tmp` → prompts to type `DELETE`.

Notes:
- `~` expands to home. Paths are quoted.
- Dangerous commands still require `DELETE` confirmation.

## Project Scaffolding

- Type: `start a new coding project in <path>`
  - Creates directory (mkdir -p), switches into it, `git init` (best-effort), creates `src/`, `tests/`, a starter `README.md`, and a `.gitignore` with common entries.

## TUI — Interactive File Browser and Search

Launch with `\tui`. Use keys below to navigate and perform actions. Quits with `q` or Ctrl+C.

### Layout

- Left: File tree, or search result list
- Right: Preview of selected file (first 200 lines)
- Header: Shows current path and pinned tabs
- Footer: Contextual key hints

### Navigation

- Up/Down: Move selection
- Left/Right: Collapse/expand directory
- Enter: Select (no open in external editor; preview updates automatically)
- o: Open selected in OS (Finder/Explorer/xdg-open)

### Search

- /: Quick grep by string (case-insensitive)
- g: Advanced grep with prompts for:
  - Pattern (supports regex option)
  - Include glob (e.g., `*.ts`)
  - Exclude glob (e.g., `*.min.js`)
  - Case sensitivity and regex toggle
- n / N: Next / previous result
- b: Back to browse mode

### Fuzzy Finder

- f: Toggle fuzzy mode
  - Type to filter files by name (in-order fuzzy match)
  - Enter: Jump to file in tree
  - Esc: Cancel

### Inline File Operations

- r: Rename selected file/directory
- m: Make directory under current folder
- i: New file under current folder
- d: Delete selected (requires typing `DELETE`)
- s: Set the current directory (or parent of a file) as the session working directory
- Command palette `:` also supports:
  - `rename <newname>`
  - `mkdir <name>`
  - `new file <name>` or `touch <name>`
  - `delete` (confirm required)

### Multi-select (Search Results)

- Space: Toggle select result
- O: Open all selected in OS file manager

### Tabs (Pinned Files)

- t: Pin current file (adds to tabs)
- x: Unpin active tab
- [ / ]: Cycle through tabs
- P: Toggle previewing the active tab instead of the current selection

### Ask AI from TUI

- a: Ask AI to review the selected file
  - TUI closes, chat sends file to AI and prints the answer
- A: “Fix file” flow
  - Prompts for an instruction (e.g., “convert var to const, fix lint errors”)
  - Sends file + instruction with a strict `tool_code` writeback format
  - The AI’s response writes the updated file (you’ll see write notifications)

## Visual Mode (Tri‑pane)

Enter with `\visual` (alias `\v`). Visual mode keeps you inside a three‑pane interface while chatting with the AI and browsing files.

- Layout: Files (left), Preview (middle; wrapped), Chat (right; wrapped)
- Status bar: Shows current focus (Files/Preview/Chat), CWD, and Auto‑scan state
- Controls:
  - Tab / Shift+Tab: Cycle focus across panes
  - C: Ask AI (inline prompt appears inside the Chat pane; Esc cancels)
  - V: Toggle tri‑pane on/off
  - S: Toggle Auto‑scan (toast appears; saved to config)
  - PgUp/PgDn, Up/Down: Scroll Chat or Preview when focused
- q: Quit visual mode

Notes:
- Safe FS ops (read/list/exists) suggested by the AI are auto‑approved in Visual mode and rendered in Chat.
- Auto‑scan runs only for explicitly project‑scoped questions (e.g., “about X in this app/project/repo/codebase/directory”) or when you say “review”.

### Edit View (single file)

Open from Visual mode by selecting a file and pressing `E`.

- Layout: Editor (left, Vim‑like) and AI Chat (right)
- Status bar: Shows mode (NORMAL/INSERT), cursor position, modified flag
- Editor keys:
  - Normal mode: `h/j/k/l` move, `i` insert, `o` new line below, `G` bottom, `Ctrl‑f`/`Ctrl‑b` page down/up, `:w` save, `:q` quit, `:wq` save+quit
  - Insert mode: type to edit; Enter splits line; Backspace deletes/joins; `Esc` to Normal
  - Help: `?` toggles a small contextual help bar with the most likely commands for the current mode
- AI integration:
  - `C`: Enter an instruction (prompt appears in Chat pane). The AI returns a full updated file; the buffer updates immediately.
  - Save with `:w` to write to disk. You remain in the editor until `:q`/`:wq`.
  - Safe FS ops are auto‑approved; destructive operations still require you to write/save changes explicitly.

## Tips

- Reply `yes` to run commands shown in the last AI message without an extra prompt.
- The prompt path always reflects the app’s working directory and updates after `cd`.
- Use `\a` for one-off agentic tasks that require multi-step planning and parallelism.

## Troubleshooting

- Missing API key: Ensure `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY` are set.
- Copy to clipboard fails: Output is saved to `clipboard.txt` in your current directory.
- Windows specifics: Some archive exclusions aren’t supported on PowerShell; messages will note this.

---

If you’d like a richer highlight engine or built-in editing, we can add a small dependency. Otherwise, this setup stays dependency-free and fast.
- Navigation mode from chat:
  - `\cd <path>`: Change the session working directory (expands `~`, supports relative paths)
  - `\nav`: Interactive navigation mode without the full TUI; use a list to browse directories, set location, and exit

## Command Reference (Quick Look)

Use these tables for a fast reminder. Short, clear words. High contrast recommended in your terminal.

### Chat Commands (type in the prompt)

| Command | Meaning |
|---|---|
| `\help` | Show help |
| `\menu` | Open settings |
| `\exit` | Quit app |
| `\clear` / `\cls` | Clear chat / screen |
| `\copy` | Copy last answer |
| `\copy-all` | Copy full session |
| `\d <text>` | Ask powerful model directly |
| `\a <text>` | Run this one with agents |
| `\visual` / `\v` | Open Visual (three panes) |
| `\tui` | Open file browser only |
| `\auto-scan on|off` | Toggle local scan |

### Visual Mode (three panes)

| Key | Action |
|---|---|
| Tab / Shift+Tab | Move focus: Files → Preview → Chat |
| V | Toggle three‑pane on/off |
| C | Ask AI (prompt in Chat). Esc cancels |
| (Auto context) | When you press C, the selected file’s path and a short preview are sent with your question so you can talk about that file right away |
| S | Toggle Auto‑scan |
| PgUp / PgDn | Scroll page (Chat/Preview) |
| ↑ / ↓ | Scroll line (Chat/Preview) |
| h / l | Collapse / Expand folder (Files) |
| j / k | Move down / up (Files) or scroll (Chat/Preview) |
| G | Bottom / end |
| E | Edit selected file (open Editor view) |
| q | Quit Visual |

### TUI (file browser) keys

| Key | Action |
|---|---|
| f | Fuzzy find file |
| / | Quick grep |
| g | Advanced grep with options |
| n / N | Next / Prev search hit |
| : | Command palette (rename, mkdir, touch, delete) |
| r / m / i / d | Rename / Make dir / New file / Delete |
| t / x / [ / ] / P | Pin / Unpin / Prev / Next / Toggle pin preview |
| a | Ask AI about selected file |
| A | “Fix file” with AI (writeback) |
| o / O | Open in OS / Open selected results |
| s | Set current directory |
| q | Quit TUI |

### Editor View (single file, Vim‑like)

Editor left; AI Chat right. Status bar shows mode and cursor (ROW:COL). Help bar can be toggled.

| Key (Normal) | Action |
|---|---|
| h / j / k / l | Left / Down / Up / Right |
| i | Insert mode |
| o | New line below + insert |
| G | Go to bottom |
| Ctrl‑f / Ctrl‑b | Page down / up |
| :w | Save file |
| :q | Quit (no save) |
| :wq | Save and quit |
| C | Ask AI to change this file (buffer updates) |
| ? | Toggle help bar |

| Key (Insert) | Action |
|---|---|
| type | Insert text |
| Enter | Split line |
| Backspace | Delete / join lines |
| Esc | Back to Normal mode |

### AI + Files (safe operations)

| Operation | Behavior |
|---|---|
| read / list / exists | Auto‑approved when safe; results shown in Chat |
| write | Needs your save (e.g., `:w`) or your explicit action |

## Readability Tips

Small changes can help a lot:

- Use a clean monospace font (no ligatures). Examples: Menlo, Fira Mono, JetBrains Mono.
- Increase font size. Increase line height if your terminal allows it.
- Use a dark theme with strong contrast. Avoid bright gradients.
- Keep the window wider. Three panes fit better with room to breathe.
- Toggle the help bar (`?`) in the editor for a quick key map.
