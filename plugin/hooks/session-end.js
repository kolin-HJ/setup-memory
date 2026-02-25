#!/usr/bin/env node
/**
 * Stop Hook — Session Activity Capture
 *
 * Runs when a Claude Code session ends. Records what was worked on and
 * spawns a background AI process to update memory topic files.
 *
 * Also synchronously runs the session synthesizer (generates briefing for
 * next session start) and a periodic memory health checker.
 *
 * PORTABLE: Uses __dirname and git to resolve paths — no hardcoded values.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn, spawnSync } = require('child_process');

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
let pendingMemoryTopics = new Set();

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
          const c = content.toLowerCase();
          if (c.includes('demandplan') || c.includes('demand plan')) pendingMemoryTopics.add('demand-plan');
          if (c.includes('dashboard') || c.includes('pab')) pendingMemoryTopics.add('dashboard');
          if (c.includes('bigquery') || c.includes('schema')) pendingMemoryTopics.add('bigquery');
        }
      } catch {}
    }
    userRequests = userRequests.slice(-5);
  } catch {}
}

if (allChangedFiles) {
  const f = allChangedFiles.toLowerCase();
  if (f.includes('demandplan') || f.includes('demand_plan')) pendingMemoryTopics.add('demand-plan');
  if (f.includes('dashboard')) pendingMemoryTopics.add('dashboard');
  if (f.includes('bigquery')) pendingMemoryTopics.add('bigquery');
  if (f.includes('purchaseplan')) pendingMemoryTopics.add('purchase-plan');
}

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

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.writeFileSync(path.join(SESSIONS_DIR, 'latest.md'), sessionContent, 'utf8');
const datePath = path.join(SESSIONS_DIR, `${dateStr}.md`);
const separator = fs.existsSync(datePath) ? '\n\n---\n\n' : '';
fs.appendFileSync(datePath, separator + sessionContent, 'utf8');

if (pendingMemoryTopics.size > 0) {
  const topicsContent = [
    'Topics touched in last session that may need memory updates:',
    ...[...pendingMemoryTopics].map(t => `- [ ] \`memory/topics/${t}.md\``),
  ].join('\n');
  fs.writeFileSync(path.join(SESSIONS_DIR, 'pending-updates.md'), topicsContent, 'utf8');
} else {
  try { fs.unlinkSync(path.join(SESSIONS_DIR, 'pending-updates.md')); } catch {}
}

// Spawn background AI memory updater (detached, fire-and-forget)
if (transcriptPath) {
  const updaterScript = path.join(MEMORY_DIR, 'hooks', 'memory-updater.js');
  if (fs.existsSync(updaterScript)) {
    const child = spawn(process.execPath, [updaterScript, transcriptPath, PROJECT_DIR, MEMORY_DIR], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
}

// Run session synthesizer synchronously (fast, ~5-10s, improves next session start)
const synthScript = path.join(MEMORY_DIR, 'hooks', 'session-synthesizer.js');
if (fs.existsSync(synthScript) && transcriptPath) {
  spawnSync(process.execPath, [synthScript, transcriptPath, PROJECT_DIR, MEMORY_DIR], {
    stdio: 'inherit',
    timeout: 60000,
    windowsHide: true,
  });
}

// Periodic memory health check (runs every 10 sessions)
const healthScript = path.join(MEMORY_DIR, 'hooks', 'memory-health.js');
if (fs.existsSync(healthScript)) {
  spawnSync(process.execPath, [healthScript, PROJECT_DIR, MEMORY_DIR], {
    stdio: 'inherit',
    timeout: 120000,
    windowsHide: true,
  });
}

process.stdout.write(JSON.stringify({ decision: 'approve' }));
