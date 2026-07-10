import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const isForce = args.includes('--force') || args.includes('-y') || args.includes('-f');
const isInteractive = process.stdout.isTTY && process.stdin.isTTY && !process.env.CI;

async function askQuestion(query) {
  if (!isInteractive) return 'n';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans.trim().toLowerCase());
  }));
}

// Project root directory
const projectRoot = path.resolve(__dirname, '../..');

const agentsSkillsDir = path.join(projectRoot, '.agents/skills');
const claudeSkillsDir = path.join(projectRoot, '.claude/skills');
const codexSkillsDir = path.join(projectRoot, '.codex/skills');

async function main() {
  console.log('Setting up skills across agent CLI environments...');

  // 1. Ensure .agents/skills exists
  if (!fs.existsSync(agentsSkillsDir)) {
    fs.mkdirSync(agentsSkillsDir, { recursive: true });
    console.log(`Created directory: ${agentsSkillsDir}`);
  }

  // 2. Scan .claude/skills for source skills (that are real directories, not symlinks)
  const skillsToSetup = [];
  if (fs.existsSync(claudeSkillsDir)) {
    const items = fs.readdirSync(claudeSkillsDir);
    for (const item of items) {
      if (item.startsWith('.')) continue;
      const itemPath = path.join(claudeSkillsDir, item);
      const stat = fs.lstatSync(itemPath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        skillsToSetup.push(item);
      }
    }
  }

  // 3. Move/Copy real directories to .agents/skills to act as the primary master
  for (const skill of skillsToSetup) {
    const srcPath = path.join(claudeSkillsDir, skill);
    const destPath = path.join(agentsSkillsDir, skill);

    if (fs.existsSync(destPath) && !isForce) {
      const answer = await askQuestion(`Skill folder "${skill}" already exists in .agents/skills. Overwrite? [y/N]: `);
      if (answer !== 'y' && answer !== 'yes') {
        console.log(`Skipped moving "${skill}".`);
        continue;
      }
    }

    console.log(`Moving/Copying skill "${skill}" from .claude/skills to .agents/skills...`);
    // If destination already exists, we overwrite it recursively
    fs.cpSync(srcPath, destPath, { recursive: true, force: true });
    
    // Delete the original directory to make room for the symlink
    fs.rmSync(srcPath, { recursive: true, force: true });
  }

  // 4. Find all skills that are now in .agents/skills
  const allSkills = [];
  if (fs.existsSync(agentsSkillsDir)) {
    const items = fs.readdirSync(agentsSkillsDir);
    for (const item of items) {
      if (item.startsWith('.')) continue;
      const itemPath = path.join(agentsSkillsDir, item);
      if (fs.statSync(itemPath).isDirectory()) {
        allSkills.push(item);
      }
    }
  }

  // Ensure target directories for links exist
  if (!fs.existsSync(claudeSkillsDir)) {
    fs.mkdirSync(claudeSkillsDir, { recursive: true });
  }
  if (!fs.existsSync(codexSkillsDir)) {
    fs.mkdirSync(codexSkillsDir, { recursive: true });
  }

  // 5. Create relative symlinks in .claude/skills and .codex/skills
  for (const skill of allSkills) {
    const claudeLinkPath = path.join(claudeSkillsDir, skill);
    const codexLinkPath = path.join(codexSkillsDir, skill);

    // Target paths must be relative to the symlink's folder
    // E.g., for .claude/skills/bag-memo, target is '../../.agents/skills/bag-memo'
    const relativeTarget = path.join('../../.agents/skills', skill);

    // Link for Claude Code (.claude/skills/)
    await setupSymlink(claudeLinkPath, relativeTarget, skill, '.claude/skills');

    // Link for Codex (.codex/skills/)
    await setupSymlink(codexLinkPath, relativeTarget, skill, '.codex/skills');
  }

  console.log('Skills setup complete!');

  // MCP setup integration
  if (isInteractive && !isForce) {
    const runMcpSetup = await askQuestion('\nDo you want to set up the MCP daemon and register it to Claude Code as well? [y/N]: ');
    if (runMcpSetup === 'y' || runMcpSetup === 'yes') {
      const setupMcpModule = await import('./setup-mcp.mjs');
      await setupMcpModule.setupMcp({ isInteractive, isForce, skipInitialPrompt: true });
    }
  }
}

async function setupSymlink(linkPath, relativeTarget, skill, label) {
  let isLinkCorrect = false;
  if (fs.existsSync(linkPath) || isSymlink(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      if (currentTarget === relativeTarget) {
        isLinkCorrect = true;
      } else {
        console.log(`Symlink ${linkPath} points to ${currentTarget}, but should point to ${relativeTarget}. Recreating...`);
        fs.unlinkSync(linkPath);
      }
    } else {
      if (!isForce) {
        const answer = await askQuestion(`Directory ${linkPath} exists but is not a symlink (it is a real directory). Delete and replace with symlink? [y/N]: `);
        if (answer !== 'y' && answer !== 'yes') {
          console.log(`Skipped replacing ${linkPath} with symlink.`);
          return;
        }
      }
      console.log(`Directory ${linkPath} exists but is not a symlink. Removing to create symlink...`);
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }

  if (!isLinkCorrect) {
    fs.symlinkSync(relativeTarget, linkPath, 'dir');
    console.log(`Created symlink: ${label}/${skill} -> ${relativeTarget}`);
  } else {
    console.log(`Symlink ${label}/${skill} is already correct.`);
  }
}

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch (_) {
    return false;
  }
}

main().catch((err) => {
  console.error('Error setting up skills:', err);
  process.exit(1);
});
