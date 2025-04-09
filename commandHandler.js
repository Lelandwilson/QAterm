import { startNewCodingProject } from './projectStarter.js';

// Import required modules
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store the original installation directory
const installDir = __dirname;

// Import config from installation directory (not working directory)
import configJson from './config.json' assert { type: 'json' };
const config = configJson;

// In your command processing function
async function processCommand(command) {
  // ... existing code ...
  
  // Split command and arguments
  const parts = command.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);
  
  if (cmd === '\\home') {
    // Get the first allowed directory as the home directory
    const homeDir = config.agent.allowedDirectories[0];
    if (homeDir) {
      // Change to the home directory
      process.chdir(homeDir);
      return `Changed directory to home: ${homeDir}`;
    } else {
      return "No home directory configured. Please add one to agent.allowedDirectories in config.json.";
    }
  }
  
  if (cmd === '\\start-project' || cmd === '\\new-project') {
    return await startNewCodingProject();
  }
  
  if (cmd === '\\review-project') {
    return await reviewProject(args[0] || process.cwd());
  }
  
  if (cmd === '\\smart' || cmd === '\\sm') {
    config.smartMode.enabled = !config.smartMode.enabled;
    config.directMode.enabled = !config.smartMode.enabled;
    return `Smart mode ${config.smartMode.enabled ? 'enabled' : 'disabled'} - ${config.smartMode.enabled ? 'Using lightweight model for classification and routing' : 'Using powerful model directly for all queries'}`;
  }
  
  if (cmd === '\\think' || cmd === '\\t') {
    config.directMode.skipReasoning = !config.directMode.skipReasoning;
    return `Thinking mode ${!config.directMode.skipReasoning ? 'enabled' : 'disabled'} - ${!config.directMode.skipReasoning ? 'Reasoning enabled for more thoughtful responses' : 'Reasoning disabled for faster responses (default)'}`;
  }
  
  // ... existing code ...
}

// Project review functionality
async function reviewProject(projectPath) {
  try {
    const stats = {};
    projectPath = path.resolve(projectPath);
    
    if (!fs.existsSync(projectPath)) {
      return `Error: Path ${projectPath} does not exist.`;
    }
    
    // Get basic project info
    stats.path = projectPath;
    stats.name = path.basename(projectPath);
    stats.isGitRepo = fs.existsSync(path.join(projectPath, '.git'));
    
    // Detect project type
    stats.projectType = detectProjectType(projectPath);
    
    // Get file statistics
    const fileStats = getProjectFileStats(projectPath);
    stats.fileCount = fileStats.totalFiles;
    stats.directoryCount = fileStats.totalDirs;
    stats.fileTypes = fileStats.fileTypes;
    stats.totalSize = formatBytes(fileStats.totalSize);
    
    // Get structure
    stats.topLevelDirs = getTopLevelDirectories(projectPath);
    
    // Format the report
    const report = formatProjectReport(stats);
    
    return report;
  } catch (error) {
    return `Error reviewing project: ${error.message}`;
  }
}

// Helper functions for project review
function detectProjectType(projectPath) {
  const indicators = {
    'package.json': 'JavaScript/Node.js',
    'tsconfig.json': 'TypeScript',
    'requirements.txt': 'Python',
    'setup.py': 'Python',
    'pom.xml': 'Java (Maven)',
    'build.gradle': 'Java/Kotlin (Gradle)',
    'CMakeLists.txt': 'C/C++',
    'Cargo.toml': 'Rust',
    'go.mod': 'Go',
    'composer.json': 'PHP',
    'Gemfile': 'Ruby',
    '.csproj': 'C#/.NET'
  };
  
  let detectedType = 'Unknown';
  
  for (const [file, type] of Object.entries(indicators)) {
    const filePath = path.join(projectPath, file);
    if (fs.existsSync(filePath)) {
      detectedType = type;
      break;
    }
    
    // Check for .csproj files
    if (file === '.csproj') {
      const files = fs.readdirSync(projectPath);
      if (files.some(f => f.endsWith('.csproj'))) {
        detectedType = type;
        break;
      }
    }
  }
  
  // More specific detection based on files
  if (detectedType === 'JavaScript/Node.js') {
    if (fs.existsSync(path.join(projectPath, 'angular.json'))) {
      return 'Angular';
    }
    if (fs.existsSync(path.join(projectPath, 'next.config.js'))) {
      return 'Next.js';
    }
    if (directoryExists(projectPath, 'src') && fileContains(path.join(projectPath, 'package.json'), 'react')) {
      return 'React';
    }
    if (fs.existsSync(path.join(projectPath, 'vue.config.js')) || fileContains(path.join(projectPath, 'package.json'), 'vue')) {
      return 'Vue.js';
    }
  }
  
  if (detectedType === 'Python') {
    if (fs.existsSync(path.join(projectPath, 'manage.py'))) {
      return 'Django';
    }
    if (directoryContainsFile(projectPath, 'app.py') || directoryContainsFile(projectPath, 'flask')) {
      return 'Flask';
    }
    if (directoryContainsFile(projectPath, 'fastapi')) {
      return 'FastAPI';
    }
  }
  
  return detectedType;
}

function getProjectFileStats(dirPath, stats = { totalFiles: 0, totalDirs: 0, totalSize: 0, fileTypes: {} }) {
  const files = fs.readdirSync(dirPath);
  
  files.forEach(file => {
    const filePath = path.join(dirPath, file);
    const isDirectory = fs.statSync(filePath).isDirectory();
    
    if (isDirectory) {
      // Skip node_modules, .git, and other common large directories
      if (['node_modules', '.git', 'venv', 'env', '__pycache__', 'dist', 'build'].includes(file)) {
        return;
      }
      
      stats.totalDirs++;
      getProjectFileStats(filePath, stats);
    } else {
      stats.totalFiles++;
      const fileSize = fs.statSync(filePath).size;
      stats.totalSize += fileSize;
      
      // Track file extensions
      const ext = path.extname(file).toLowerCase();
      if (ext) {
        stats.fileTypes[ext] = (stats.fileTypes[ext] || 0) + 1;
      }
    }
  });
  
  return stats;
}

function getTopLevelDirectories(dirPath) {
  const topDirs = [];
  const items = fs.readdirSync(dirPath);
  
  items.forEach(item => {
    const itemPath = path.join(dirPath, item);
    
    if (fs.statSync(itemPath).isDirectory() && 
        !['node_modules', '.git', 'venv', 'env', '__pycache__'].includes(item)) {
      topDirs.push(item);
    }
  });
  
  return topDirs;
}

function formatProjectReport(stats) {
  let report = `# Project Review: ${stats.name}\n\n`;
  
  report += `## Basic Information\n`;
  report += `- **Project path:** ${stats.path}\n`;
  report += `- **Project type:** ${stats.projectType}\n`;
  report += `- **Git repository:** ${stats.isGitRepo ? 'Yes' : 'No'}\n\n`;
  
  report += `## Project Structure\n`;
  report += `- **Top-level directories:** ${stats.topLevelDirs.join(', ')}\n`;
  report += `- **Total files:** ${stats.fileCount}\n`;
  report += `- **Total directories:** ${stats.directoryCount}\n`;
  report += `- **Total size:** ${stats.totalSize}\n\n`;
  
  report += `## File Types\n`;
  Object.entries(stats.fileTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([ext, count]) => {
      report += `- ${ext}: ${count} files\n`;
    });
  
  return report;
}

// Utility functions
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function directoryExists(basePath, dirName) {
  const dirPath = path.join(basePath, dirName);
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

function fileContains(filePath, searchString) {
  if (!fs.existsSync(filePath)) return false;
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.includes(searchString);
  } catch (error) {
    return false;
  }
}

function directoryContainsFile(dirPath, searchFile) {
  if (!fs.existsSync(dirPath)) return false;
  
  try {
    const filesInDir = fs.readdirSync(dirPath);
    return filesInDir.some(file => file.includes(searchFile));
  } catch (error) {
    return false;
  }
}

// Export functions
export { processCommand, reviewProject };