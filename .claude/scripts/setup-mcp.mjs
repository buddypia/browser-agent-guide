import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const daemonDir = path.join(projectRoot, 'daemon');

async function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans.trim().toLowerCase());
  }));
}

export async function setupMcp(options = {}) {
  const isInteractive = options.isInteractive !== false;
  const isForce = options.isForce === true;
  const skipInitialPrompt = options.skipInitialPrompt === true;

  if (isInteractive && !isForce && !skipInitialPrompt) {
    const startMcpSetup = await askQuestion('\nDo you want to set up the MCP daemon? (This will install daemon dependencies) [y/N]: ');
    if (startMcpSetup !== 'y' && startMcpSetup !== 'yes') {
      console.log('MCP Setup skipped.');
      return;
    }
  }

  console.log('\nSetting up MCP Daemon and registering servers...');

  // 1. Install daemon dependencies
  console.log(`\nInstalling dependencies in daemon directory: ${daemonDir}...`);
  try {
    execSync('npm install', { cwd: daemonDir, stdio: 'inherit' });
    console.log('Daemon dependencies installed successfully.');
  } catch (err) {
    console.error('Failed to install daemon dependencies:', err.message);
    if (!isForce) {
      console.log('Skipping MCP registration because daemon build failed.');
      return;
    }
  }

  // 2. Ask to register MCP server
  let registerMcp = true;
  if (isInteractive && !isForce) {
    const answer = await askQuestion('\nDo you want to register bag_page_feedback to your local Claude Code? [Y/n]: ');
    registerMcp = answer !== 'n' && answer !== 'no';
  }

  if (registerMcp) {
    console.log('\nRegistering bag_page_feedback MCP server...');
    
    // Remove old alias if it exists (ignore error if it doesn't)
    try {
      execSync('claude mcp remove bag_visual_feedback', { stdio: 'ignore' });
      console.log('Removed deprecated bag_visual_feedback MCP server.');
    } catch (_) {}

    try {
      // Register new alias
      execSync('claude mcp add --transport http bag_page_feedback http://127.0.0.1:8765/mcp', { stdio: 'inherit' });
      console.log('Successfully registered bag_page_feedback MCP server to Claude Code!');
    } catch (err) {
      console.warn('\nCould not automatically run "claude mcp add". Is "claude" CLI installed and in your PATH?');
      console.log('If you are using Claude Code, please run this manually in a new session:');
      console.log('  claude mcp add --transport http bag_page_feedback http://127.0.0.1:8765/mcp');
    }
  }

  console.log('\nMCP Setup complete!');
  console.log('\nTo run the daemon and start the service:');
  console.log(`  cd ${path.relative(process.cwd(), daemonDir)}`);
  console.log('  npm start');
  console.log('\nOr setup as a persistent system service:');
  console.log('  npm run service');
}

// Support running directly
if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  const isForce = args.includes('--force') || args.includes('-y') || args.includes('-f');
  const isInteractive = process.stdout.isTTY && process.stdin.isTTY && !process.env.CI;
  
  setupMcp({ isInteractive, isForce }).catch((err) => {
    console.error('Error during MCP setup:', err);
    process.exit(1);
  });
}
