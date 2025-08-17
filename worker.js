// Agent worker thread implementation
import { parentPort, workerData } from 'worker_threads';
import OpenAI from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize AI clients based on provider
let openai = null;
let anthropic = null;
let genAI = null;
let openRouter = null;

if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
}

if (process.env.GOOGLE_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
}

if (process.env.OPENROUTER_API_KEY) {
  // Using OpenAI client with OpenRouter base URL for compatibility
  openRouter = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://qaterm.app',  // Replace with your actual site
      'X-Title': 'QAterm'
    }
  });
}

// Process the action based on agent configuration
async function processAction(agent, task, action, actionContext) {
  try {
    // Construct the action prompt
    const actionPrompt = `You are an AI agent with the role of "${agent.role}" working on a task. Your goal is: "${agent.goal}".

## Current Action to Perform
${action}

## Task Context
${task.description}

${actionContext ? '## Additional Context\n' + actionContext : ''}

Execute the current action carefully and provide your result. Format your response as a clear report of what you did and what you found.`;

    // Get AI response based on the agent's provider/model
    let actionResponse;
    
    switch (agent.provider) {
      case 'openai':
        if (!openai) throw new Error('OpenAI API key not configured');
        
        const openaiResponse = await openai.chat.completions.create({
          model: agent.model,
          messages: [
            { role: 'system', content: `You are an AI agent specialized in ${agent.type} tasks.` },
            { role: 'user', content: actionPrompt }
          ],
          ...(!(agent.model && typeof agent.model === 'string' && agent.model.startsWith('gpt-5')) ? { temperature: 0.7 } : {}),
        });
        
        actionResponse = openaiResponse.choices[0].message.content;
        break;
        
      case 'anthropic':
        if (!anthropic) throw new Error('Anthropic API key not configured');
        
        const anthropicResponse = await anthropic.messages.create({
          model: agent.model,
          system: `You are an AI agent specialized in ${agent.type} tasks.`,
          messages: [
            { role: 'user', content: actionPrompt }
          ],
          max_tokens: 2000,
          temperature: 0.7,
        });
        
        actionResponse = anthropicResponse.content[0].text;
        break;
        
      case 'google':
        if (!genAI) throw new Error('Google AI API key not configured');
        
        const systemPrompt = `You are an AI agent specialized in ${agent.type} tasks.`;
        const googleMessages = [systemPrompt, actionPrompt].join('\n\n');
        const googleModel = genAI.getGenerativeModel({ model: agent.model });
        const googleResponse = await googleModel.generateContent(googleMessages);
        
        actionResponse = googleResponse.response.text();
        break;
        
      case 'openrouter':
        if (!openRouter) throw new Error('OpenRouter API key not configured');
        
        const openRouterResponse = await openRouter.chat.completions.create({
          model: agent.model,
          messages: [
            { role: 'system', content: `You are an AI agent specialized in ${agent.type} tasks.` },
            { role: 'user', content: actionPrompt }
          ],
          temperature: 0.7,
        });
        
        actionResponse = openRouterResponse.choices[0].message.content;
        break;
        
      default:
        throw new Error(`Unknown provider: ${agent.provider}`);
    }
    
    return {
      success: true,
      result: actionResponse
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Handle messages from the main thread
parentPort.on('message', async (message) => {
  if (message.type === 'process-action') {
    const { agent, task, action, actionContext } = message.data;
    
    try {
      const result = await processAction(agent, task, action, actionContext);
      parentPort.postMessage({
        type: 'action-result',
        agentId: agent.id,
        actionIndex: message.data.actionIndex,
        result
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'action-error',
        agentId: agent.id,
        actionIndex: message.data.actionIndex,
        error: error.message
      });
    }
  }
});

// Notify main thread that worker is ready
parentPort.postMessage({ type: 'ready' });
