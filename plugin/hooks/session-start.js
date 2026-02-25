#!/usr/bin/env node
/**
 * SessionStart Hook — Auto-Injected Context
 *
 * Reads git state + synthesized session briefing (or last session log) to give
 * Claude instant awareness of:
 * - What branch/work is in progress
 * - What files are modified
 * - What was worked on in the last session (AI-synthesized briefing when available)
 * - Any pending memory updates flagged during last session
 *
 * Uses sessions/briefing.md (AI-synthesized) when available for richer context,
 * falling back to sessions/latest.md (raw session log).
 *
 * PORTABLE: Uses __dirname and git to resolve paths — no hardcoded values.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MEMORY_DIR = path.join(__dirname, '..');

function getProjectDir() {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch {
    return process.cwd();
  }
}

const PROJECT_DIR = getProjectDir();

function exec(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_DIR, timeout: 5000, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function readFile(relPath) {
  try {
    return fs.readFileSync(path.join(MEMORY_DIR, relPath), 'utf8').trim();
  } catch {
    return '';
  }
}

function detectActiveDomains(modifiedFiles) {
  const domains = new Set();
  const f = modifiedFiles.toLowerCase();
  if (f.includes('demandplan') || f.includes('demand_plan')) domains.add('demand-plan');
  if (f.includes('dashboard') || f.includes('unified')) domains.add('dashboard');
  if (f.includes('purchaseplan') || f.includes('purchase_plan')) domains.add('purchase-plan');
  if (f.includes('bigquery')) domains.add('bigquery');
  return domains;
}

const branch = exec('git branch --show-current');
const recentCommits = exec('git log --oneline -7');
const modifiedFiles = exec('git status --short');
const lastDiffFiles = exec('git diff --name-only HEAD');

// Try synthesized briefing first (richer context), fall back to raw session log
const briefing = readFile('sessions/briefing.md');
const lastSession = briefing || readFile('sessions/latest.md');
const briefingLabel = briefing ? '**Session Briefing (AI-synthesized):**' : '**Last Session Summary:**';

const pendingUpdates = readFile('sessions/pending-updates.md');

const activeDomains = detectActiveDomains(modifiedFiles + lastDiffFiles);
const domainHints = activeDomains.size > 0
  ? `\n**Active domains detected:** ${[...activeDomains].join(', ')} — consider reading memory/topics/*.md for deep context`
  : '';

const parts = [];
if (branch) parts.push(`**Branch:** \`${branch}\``);
if (recentCommits) parts.push(`**Recent Commits (last 7):**\n\`\`\`\n${recentCommits}\n\`\`\``);
if (modifiedFiles) parts.push(`**Uncommitted Changes:**\n\`\`\`\n${modifiedFiles}\n\`\`\``);
else parts.push('**Uncommitted Changes:** (working tree clean)');
if (domainHints) parts.push(domainHints);
if (lastSession) parts.push(`${briefingLabel}\n${lastSession}`);
if (pendingUpdates) parts.push(`**⚠ Pending Memory Updates (from last session):**\n${pendingUpdates}`);

const context = `## 🧠 Auto-Injected Session Context\n*Generated automatically from git state and session history.*\n\n${parts.join('\n\n')}`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
}));
