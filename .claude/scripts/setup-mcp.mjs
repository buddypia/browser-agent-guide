import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const daemonDir = path.join(projectRoot, 'daemon');
const home = os.homedir();

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
  const serverName = 'bag_page_feedback';
  const serverUrl = 'http://127.0.0.1:8765/mcp';
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

  // 2. Register MCP server
  let registerMcp = true;
  if (isInteractive && !isForce) {
    const answer = await askQuestion('\nDo you want to register bag_page_feedback to global config of your CLIs? (Claude Code, Cursor, Codex CLI, Antigravity CLI) [Y/n]: ');
    registerMcp = answer !== 'n' && answer !== 'no';
  }

  if (registerMcp) {
    console.log('\n--- 1. Registering to Claude Code ---');
    try {
      // Remove old alias if it exists (ignore error if it doesn't)
      try {
        execSync('claude mcp remove bag_visual_feedback', { stdio: 'ignore' });
        console.log('Removed deprecated bag_visual_feedback MCP server from Claude Code.');
      } catch (_) {}

      // Register new alias
      execSync(`claude mcp add --transport http ${serverName} ${serverUrl}`, { stdio: 'inherit' });
      console.log('Successfully registered bag_page_feedback MCP server to Claude Code!');
    } catch (err) {
      console.warn('Could not automatically run "claude mcp add". Trying fallback directly to ~/.mcp.json...');
      setupClaudeMcpJson(serverName, serverUrl);
    }

    console.log('\n--- 2. Registering to Codex CLI ---');
    try {
      // Remove old alias
      try {
        execSync('codex mcp remove bag_visual_feedback', { stdio: 'ignore' });
        console.log('Removed deprecated bag_visual_feedback MCP server from Codex CLI.');
      } catch (_) {}

      // Register new
      execSync(`codex mcp add ${serverName} --url ${serverUrl}`, { stdio: 'inherit' });
      console.log('Successfully registered bag_page_feedback MCP server to Codex CLI!');
    } catch (err) {
      console.warn('Could not automatically run "codex mcp add". Trying fallback directly to ~/.codex/config.toml...');
      setupCodexConfigToml(serverName, serverUrl);
    }

    console.log('\n--- 3. Registering to Cursor ---');
    setupCursorMcpJson(serverName, serverUrl);

    console.log('\n--- 4. Registering to Antigravity CLI ---');
    setupAntigravityMcpJson(serverName, serverUrl);
  }

  console.log('\nMCP Setup complete!');

  console.log('\n======================================================');
  console.log('Registered MCP Server Configurations:');
  console.log('======================================================');
  console.log('\n[Claude Code & Cursor] (mcpServers / ~/.mcp.json):');
  console.log(JSON.stringify({
    mcpServers: {
      [serverName]: {
        type: "http",
        url: serverUrl
      }
    }
  }, null, 2));

  console.log('\n[Codex CLI] (~/.codex/config.toml):');
  console.log(`[mcp_servers.${serverName}]\nurl = "${serverUrl}"`);

  console.log('\n[Antigravity CLI] (~/.gemini/antigravity-cli/settings.json):');
  console.log(JSON.stringify({
    mcpServers: {
      [serverName]: {
        serverUrl: serverUrl
      }
    }
  }, null, 2));
  console.log('======================================================');

  console.log('\nTo run the daemon and start the service:');
  console.log(`  cd ${path.relative(process.cwd(), daemonDir)}`);
  console.log('  npm start');
  console.log('\nOr setup as a persistent system service:');
  console.log('  npm run service');
}

// Fallback: Claude Code global JSON (~/.mcp.json)
function setupClaudeMcpJson(serverName, serverUrl) {
  const p = path.join(home, '.mcp.json');
  try {
    let data = { mcpServers: {} };
    if (fs.existsSync(p)) {
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    if (!data.mcpServers) data.mcpServers = {};
    
    // Remove legacy
    delete data.mcpServers['bag_visual_feedback'];

    // Add new
    data.mcpServers[serverName] = {
      type: 'http',
      url: serverUrl
    };

    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Updated Claude Code config at ${p}`);
  } catch (err) {
    console.error(`Failed to update Claude Code config at ${p}:`, err.message);
  }
}

// Fallback: Codex CLI global TOML (~/.codex/config.toml)
function setupCodexConfigToml(serverName, serverUrl) {
  const p = path.join(home, '.codex', 'config.toml');
  try {
    const parentDir = path.dirname(p);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    let content = '';
    if (fs.existsSync(p)) {
      content = fs.readFileSync(p, 'utf8');
    }

    // Remove legacy block [mcp_servers.bag_visual_feedback]
    content = content.replace(/\[mcp_servers\.bag_visual_feedback\][\s\S]*?(?=\[|$)/g, '');

    // Check if bag_page_feedback already exists
    const blockRegex = new RegExp(`\\[mcp_servers\\.${serverName}\\]`);
    if (blockRegex.test(content)) {
      // Update existing url
      content = content.replace(
        new RegExp(`(\\[mcp_servers\\.${serverName}\\][\\s\\S]*?url\\s*=\\s*")[^"]*(")`),
        `$1${serverUrl}$2`
      );
      console.log(`Updated Codex config url in ${p}`);
    } else {
      // Append new block
      if (content && !content.endsWith('\n')) content += '\n';
      content += `\n[mcp_servers.${serverName}]\nurl = "${serverUrl}"\n`;
      console.log(`Added Codex config block in ${p}`);
    }

    fs.writeFileSync(p, content, 'utf8');
  } catch (err) {
    console.error(`Failed to update Codex config at ${p}:`, err.message);
  }
}

// Cursor config
function setupCursorMcpJson(serverName, serverUrl) {
  let cursorMcpPath;
  if (process.platform === 'win32') {
    cursorMcpPath = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'moose-coding', 'mcpServers.json');
  } else if (process.platform === 'darwin') {
    cursorMcpPath = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'moose-coding', 'mcpServers.json');
  } else {
    cursorMcpPath = path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'moose-coding', 'mcpServers.json');
  }

  try {
    const parentDir = path.dirname(cursorMcpPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    let data = { mcpServers: {} };
    if (fs.existsSync(cursorMcpPath)) {
      data = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf8'));
    }
    if (!data.mcpServers) data.mcpServers = {};

    // Remove legacy
    delete data.mcpServers['bag_visual_feedback'];

    // Add new
    data.mcpServers[serverName] = {
      type: 'http',
      url: serverUrl
    };

    fs.writeFileSync(cursorMcpPath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Successfully registered Cursor config at ${cursorMcpPath}`);
  } catch (err) {
    console.error(`Failed to update Cursor config at ${cursorMcpPath}:`, err.message);
  }
}

// Antigravity CLI config
function setupAntigravityMcpJson(serverName, serverUrl) {
  const p = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  try {
    if (!fs.existsSync(p)) {
      console.log(`Antigravity CLI settings file not found at ${p}. Skipping.`);
      return;
    }

    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data.mcpServers) data.mcpServers = {};

    // Remove legacy
    delete data.mcpServers['bag_visual_feedback'];

    // Add new
    data.mcpServers[serverName] = {
      serverUrl: serverUrl
    };

    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Successfully registered Antigravity config at ${p}`);
  } catch (err) {
    console.error(`Failed to update Antigravity config at ${p}:`, err.message);
  }
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
