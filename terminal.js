// Terminal utilities module
import fs from 'fs';
import path from 'path';
import readline from 'readline';

// Improve the tab completion setup
function setupTabCompletion(rl) {
  rl.on('tab', (line) => {
    try {
      // Handle empty input
      if (!line) {
        const files = fs.readdirSync('.');
        console.log('\n');
        files.forEach(file => console.log(file));
        rl.prompt();
        return;
      }
      
      // Extract the last token for completion (handle spaces properly)
      const tokens = line.split(/\s+/);
      const lastToken = tokens.pop() || '';
      const prefix = tokens.join(' ') + (tokens.length > 0 ? ' ' : '');
      
      // Handle relative paths
      let dir = '.';
      let base = lastToken;
      
      if (lastToken.includes('/')) {
        dir = path.dirname(lastToken);
        base = path.basename(lastToken);
      }
      
      // Get matching files
      const files = fs.readdirSync(dir);
      const matches = files.filter(file => file.startsWith(base));
      
      if (matches.length === 0) {
        // No matches
        rl.prompt();
        rl.write(line);
      } else if (matches.length === 1) {
        // Single match - complete it
        const match = matches[0];
        const isDirectory = fs.statSync(path.join(dir, match)).isDirectory();
        
        // Replace the current line
        rl.line = prefix + path.join(dir === '.' ? '' : dir, match) + (isDirectory ? '/' : '');
        rl.cursor = rl.line.length;
        rl.prompt();
        rl.write('');  // Trick to refresh line
      } else {
        // Multiple matches
        // Find common prefix among matches
        const commonPrefix = getCommonPrefix(matches);
        
        if (commonPrefix.length > base.length) {
          // We can partially complete
          rl.line = prefix + path.join(dir === '.' ? '' : dir, commonPrefix);
          rl.cursor = rl.line.length;
          rl.prompt();
          rl.write('');
        } else {
          // Show all possibilities
          console.log('\n');
          matches.forEach(match => {
            const isDir = fs.statSync(path.join(dir, match)).isDirectory();
            console.log(`${match}${isDir ? '/' : ''}`);
          });
          rl.prompt();
          rl.write(line);
        }
      }
    } catch (error) {
      // Silently handle errors
      rl.prompt();
      rl.write(line);
    }
  });
}

// Helper function to find common prefix among strings
function getCommonPrefix(strings) {
  if (!strings.length) return '';
  if (strings.length === 1) return strings[0];
  
  let prefix = '';
  const firstString = strings[0];
  
  for (let i = 0; i < firstString.length; i++) {
    const char = firstString[i];
    if (strings.every(string => string[i] === char)) {
      prefix += char;
    } else {
      break;
    }
  }
  
  return prefix;
}

// Use in your terminal setup
function setupTerminal() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${process.cwd()}> `
  });
  
  setupTabCompletion(rl);
  
  rl.prompt();
  
  rl.on('line', async (line) => {
    try {
      const trimmedLine = line.trim();
      
      if (!trimmedLine) {
        rl.prompt();
        return;
      }
      
      // Process the command
      const result = await processCommand(trimmedLine);
      console.log(result);
      
      // Update prompt with current directory
      rl.setPrompt(`${process.cwd()}> `);
      rl.prompt();
    } catch (error) {
      console.error('Error:', error.message);
      rl.prompt();
    }
  });
  
  rl.on('close', () => {
    console.log('Terminal closed');
    process.exit(0);
  });
  
  return rl;
}

// Export both functions
export { setupTabCompletion, setupTerminal };
