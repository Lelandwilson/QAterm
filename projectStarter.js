import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';

// Main function to start a new coding project
async function startNewCodingProject() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  // Helper function for prompting
  const prompt = (question) => new Promise((resolve) => {
    rl.question(question, resolve);
  });
  
  try {
    // Get project details
    const projectName = await prompt('Project name: ');
    const language = await prompt('Base language (js, typescript, python, c, c++): ').then(l => l.toLowerCase());
    
    // Create project directory
    const projectDir = path.join(process.cwd(), projectName);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir);
    }
    process.chdir(projectDir);
    
    // Initialize git
    execSync('git init');
    
    // Create basic .gitignore
    const gitignoreContent = `.env\nnode_modules/\n__pycache__/\n*.pyc\n.DS_Store\n.vscode/\ndist/\nbuild/\n`;
    fs.writeFileSync(path.join(projectDir, '.gitignore'), gitignoreContent);
    
    // Create basic README.md
    const readmeContent = `# ${projectName}\n\nA new project.\n`;
    fs.writeFileSync(path.join(projectDir, 'README.md'), readmeContent);
    
    // Language-specific setup
    if (language === 'js' || language === 'javascript' || language === 'typescript') {
      const framework = await prompt('Framework (node, next, react, vue, vite, none): ').then(f => f.toLowerCase());
      
      // Initialize npm
      execSync('npm init -y');
      
      // Framework-specific setup
      if (framework === 'next') {
        console.log('Setting up Next.js project...');
        execSync('npx create-next-app@latest . --use-npm --eslint --tailwind --app --src-dir --typescript', {stdio: 'inherit'});
      } else if (framework === 'react') {
        console.log('Setting up React project...');
        if (await prompt('Use Vite for React? (y/n): ') === 'y') {
          execSync('npm create vite@latest . -- --template react', {stdio: 'inherit'});
        } else {
          execSync('npx create-react-app .', {stdio: 'inherit'});
        }
      } else if (framework === 'vue') {
        console.log('Setting up Vue project...');
        execSync('npm create vue@latest .', {stdio: 'inherit'});
      } else if (framework === 'vite') {
        console.log('Setting up Vite project...');
        const viteTemplate = language === 'typescript' ? 'vanilla-ts' : 'vanilla';
        execSync(`npm create vite@latest . -- --template ${viteTemplate}`, {stdio: 'inherit'});
      } else if (framework === 'node') {
        console.log('Setting up Node.js project...');
        // Create basic folder structure
        const dirs = ['src', 'tests', 'config'];
        dirs.forEach(dir => {
          if (!fs.existsSync(path.join(projectDir, dir))) {
            fs.mkdirSync(path.join(projectDir, dir));
          }
        });
        
        // Create basic entry file
        const indexContent = language === 'typescript' 
          ? `console.log('Hello, TypeScript!');\n`
          : `console.log('Hello, JavaScript!');\n`;
        
        const indexExt = language === 'typescript' ? 'ts' : 'js';
        fs.writeFileSync(path.join(projectDir, 'src', `index.${indexExt}`), indexContent);
        
        // Install TypeScript if needed
        if (language === 'typescript') {
          execSync('npm install --save-dev typescript @types/node', {stdio: 'inherit'});
          const tsconfigContent = {
            compilerOptions: {
              target: "es2016",
              module: "commonjs",
              outDir: "./dist",
              esModuleInterop: true,
              forceConsistentCasingInFileNames: true,
              strict: true,
              skipLibCheck: true
            },
            include: ["src/**/*"]
          };
          fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify(tsconfigContent, null, 2));
        }
      } else {
        // Basic JS/TS setup
        console.log('Setting up basic project...');
        const dirs = ['src'];
        dirs.forEach(dir => {
          if (!fs.existsSync(path.join(projectDir, dir))) {
            fs.mkdirSync(path.join(projectDir, dir));
          }
        });
        
        const indexContent = language === 'typescript' 
          ? `console.log('Hello, TypeScript!');\n`
          : `console.log('Hello, JavaScript!');\n`;
        
        const indexExt = language === 'typescript' ? 'ts' : 'js';
        fs.writeFileSync(path.join(projectDir, 'src', `index.${indexExt}`), indexContent);
        
        if (language === 'typescript') {
          execSync('npm install --save-dev typescript', {stdio: 'inherit'});
          const tsconfigContent = {
            compilerOptions: {
              target: "es2016",
              module: "commonjs",
              outDir: "./dist",
              esModuleInterop: true,
              forceConsistentCasingInFileNames: true,
              strict: true,
              skipLibCheck: true
            },
            include: ["src/**/*"]
          };
          fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify(tsconfigContent, null, 2));
        }
      }
    } else if (language === 'python') {
      const framework = await prompt('Framework (flask, django, fastapi, none): ').then(f => f.toLowerCase());
      
      // Create virtual environment
      execSync('python -m venv venv', {stdio: 'inherit'});
      
      // Create basic structure
      const dirs = ['src', 'tests'];
      dirs.forEach(dir => {
        if (!fs.existsSync(path.join(projectDir, dir))) {
          fs.mkdirSync(path.join(projectDir, dir));
        }
      });
      
      // Create empty __init__.py files
      fs.writeFileSync(path.join(projectDir, 'src', '__init__.py'), '');
      fs.writeFileSync(path.join(projectDir, 'tests', '__init__.py'), '');
      
      // Create requirements.txt
      let requirementsContent = '';
      
      if (framework === 'flask') {
        requirementsContent = 'flask\n';
        // Create basic app.py
        const appContent = `from flask import Flask\n\napp = Flask(__name__)\n\n@app.route('/')\ndef hello():\n    return "Hello, World!"\n\nif __name__ == '__main__':\n    app.run(debug=True)\n`;
        fs.writeFileSync(path.join(projectDir, 'src', 'app.py'), appContent);
      } else if (framework === 'django') {
        requirementsContent = 'django\n';
        console.log('Django project setup requires running django-admin commands. After setup:');
        console.log('1. Activate your virtual environment');
        console.log('2. Install Django: pip install django');
        console.log('3. Run: django-admin startproject mysite .');
      } else if (framework === 'fastapi') {
        requirementsContent = 'fastapi\nuvicorn\n';
        // Create basic main.py
        const mainContent = `from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/")\ndef read_root():\n    return {"Hello": "World"}\n`;
        fs.writeFileSync(path.join(projectDir, 'src', 'main.py'), mainContent);
      } else {
        // Basic Python setup
        const mainContent = `def main():\n    print("Hello, World!")\n\nif __name__ == "__main__":\n    main()\n`;
        fs.writeFileSync(path.join(projectDir, 'src', 'main.py'), mainContent);
      }
      
      fs.writeFileSync(path.join(projectDir, 'requirements.txt'), requirementsContent);
    } else if (language === 'c' || language === 'c++') {
      // Create basic structure
      const dirs = ['src', 'include', 'build'];
      dirs.forEach(dir => {
        if (!fs.existsSync(path.join(projectDir, dir))) {
          fs.mkdirSync(path.join(projectDir, dir));
        }
      });
      
      // Create a basic CMakeLists.txt
      const cmakeContent = `cmake_minimum_required(VERSION 3.10)\nproject(${projectName})\n\nset(CMAKE_CXX_STANDARD 17)\n\ninclude_directories(include)\n\nadd_executable(${projectName} src/main.${language})\n`;
      fs.writeFileSync(path.join(projectDir, 'CMakeLists.txt'), cmakeContent);
      
      // Create a simple main file
      const mainContent = language === 'c' 
        ? `#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}\n`
        : `#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}\n`;
      
      fs.writeFileSync(path.join(projectDir, 'src', `main.${language}`), mainContent);
    }
    
    console.log(`Project ${projectName} has been set up successfully!`);
    return `Project ${projectName} created successfully.`;
  } catch (error) {
    console.error('Error setting up project:', error);
    return `Error setting up project: ${error.message}`;
  } finally {
    rl.close();
  }
}

export { startNewCodingProject }; 