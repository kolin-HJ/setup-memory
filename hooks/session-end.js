#!/usr/bin/env node
/**
 * Stop Hook — Session Activity Capture
 *
 * Runs when a Claude Code session ends. Records what was worked on and
 * spawns all background AI processes as detached fire-and-forget jobs:
 *   - memory-updater.js   — two-pass recursive topic file updates
 *   - session-synthesizer.js — generates briefing for next session start
 *   - memory-health.js    — periodic topic file health check (every 10 sessions)
 *
 * Returns immediately so the Stop hook completes in under a second.
 *
 * PORTABLE: Uses __dirname and git to resolve paths — no hardcoded values.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const MEMORY_DIR = path.join(__dirname, '..');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');

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

function detectPendingTopics(changedFiles, assistantContent) {
  const pending = new Set();
  try {
    const topicsDir = path.join(MEMORY_DIR, 'topics');
    const existing = fs.readdirSync(topicsDir).filter(f => f.endsWith('.md'));
    const combined = (changedFiles + ' ' + assistantContent).toLowerCase();
    for (const topicFile of existing) {
      const keyword = topicFile.replace('.md', '').replace(/-/g, '');
      const keyword2 = topicFile.replace('.md', '');
      const keyword3 = topicFile.replace('.md', '').replace(/-/g, '_');
      if (combined.includes(keyword) || combined.includes(keyword2) || combined.includes(keyword3)) {
        pending.add(topicFile.replace('.md', ''));
      }
    }
  } catch {}
  return pending;
}

const now = new Date();
const dateStr = now.toISOString().split('T')[0];
const timeStr = now.toTimeString().slice(0, 5);

const branch = exec('git branch --show-current');
const recentCommits = exec('git log --oneline -5');
const modifiedFiles = exec('git diff --name-only HEAD');
const stagedFiles = exec('git diff --name-only --staged');
const allChangedFiles = [...new Set([
  ...modifiedFiles.split('\n'),
  ...stagedFiles.split('\n'),
].filter(Boolean))].join('\n');

let userRequests = [];
let assistantContent = '';

const transcriptPath = process.env.CLAUDE_TRANSCRIPT_PATH;
if (transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || entry;
        if (msg.role === 'user') {
          const content = Array.isArray(msg.content)
            ? msg.content.map(c => c.text || '').join(' ')
            : (msg.content || '');
          const trimmed = content.trim().slice(0, 300);
          if (trimmed && !trimmed.startsWith('[Tool')) userRequests.push(trimmed);
        }
        if (msg.role === 'assistant') {
          const content = Array.isArray(msg.content)
            ? msg.content.map(c => c.text || '').join(' ')
            : (msg.content || '');
          assistantContent += content + ' ';
        }
      } catch {}
    }
    userRequests = userRequests.slice(-5);
  } catch {}
}

const pendingMemoryTopics = detectPendingTopics(allChangedFiles, assistantContent);

const lines = [`**${dateStr} ${timeStr}** | Branch: \`${branch || 'unknown'}\``, ''];
if (allChangedFiles) {
  lines.push('**Files Changed:**', '```', allChangedFiles, '```');
} else {
  lines.push('**Files Changed:** (none)');
}
if (recentCommits) {
  lines.push('', '**Commits:**', '```', recentCommits, '```');
}
if (userRequests.length > 0) {
  lines.push('', '**What Was Worked On:**');
  userRequests.forEach(r => lines.push(`- ${r.replace(/\n/g, ' ')}`));
}

const sessionContent = lines.join('\n');

try {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, 'latest.md'), sessionContent, 'utf8');
  const datePath = path.join(SESSIONS_DIR, `${dateStr}.md`);
  const separator = fs.existsSync(datePath) ? '\n\n---\n\n' : '';
  fs.appendFileSync(datePath, separator + sessionContent, 'utf8');
} catch {}

if (pendingMemoryTopics.size > 0) {
  const topicsContent = [
    'Topics touched in last session that may need memory updates:',
    ...[...pendingMemoryTopics].map(t => `- [ ] \`memory/topics/${t}.md\``),
  ].join('\n');
  fs.writeFileSync(path.join(SESSIONS_DIR, 'pending-updates.md'), topicsContent, 'utf8');
} else {
  try { fs.unlinkSync(path.join(SESSIONS_DIR, 'pending-updates.md')); } catch {}
}

// Log that background jobs are being spawned
const logPath = path.join(MEMORY_DIR, 'sessions', 'updater-log.md');
const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
try {
  fs.appendFileSync(logPath, `\n## ${timestamp} — session ended, spawning background jobs\n`, 'utf8');
} catch {}

function spawnDetached(script, args) {
  if (!fs.existsSync(script)) return;
  const child = spawn(process.execPath, [script, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: PROJECT_DIR,
  });
  child.unref();
}

// Spawn all three background jobs (detached, fire-and-forget)
if (transcriptPath) {
  spawnDetached(path.join(MEMORY_DIR, 'hooks', 'memory-updater.js'), [transcriptPath, PROJECT_DIR, MEMORY_DIR]);
  spawnDetached(path.join(MEMORY_DIR, 'hooks', 'session-synthesizer.js'), [transcriptPath, PROJECT_DIR, MEMORY_DIR]);
}
spawnDetached(path.join(MEMORY_DIR, 'hooks', 'memory-health.js'), [PROJECT_DIR, MEMORY_DIR]);

process.stdout.write(JSON.stringify({ decision: 'approve' }));
