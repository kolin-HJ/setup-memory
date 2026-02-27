#!/usr/bin/env node
/**
 * Memory Health Check — Recursive Topic File Consolidation
 *
 * Runs every N sessions. Two-pass recursive review:
 * Pass 1: Audit all topic files for quality issues
 * Pass 2: Based on the audit, rewrite/consolidate
 *
 * Triggered by session-end.js after every session. Uses health-state.json
 * to track session count and only runs every 10 sessions.
 *
 * Based on "Test-time Recursive Thinking" research (Feb 2026).
 *
 * PORTABLE: All paths passed as arguments — no hardcoded values.
 *
 * Usage: node memory-health.js <projectDir> <memoryDir>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [,, projectDir, memoryDir] = process.argv;

if (!projectDir || !memoryDir) process.exit(0);

const sessionsDir = path.join(memoryDir, 'sessions');
const topicsDir = path.join(memoryDir, 'topics');
const healthStatePath = path.join(sessionsDir, 'health-state.json');
const logPath = path.join(sessionsDir, 'updater-log.md');
const SESSIONS_BETWEEN_RUNS = 10;

// Read or initialize health state
let healthState = { lastRun: null, sessionCount: 0 };
try {
  healthState = JSON.parse(fs.readFileSync(healthStatePath, 'utf8'));
} catch {}

// Increment session count
healthState.sessionCount = (healthState.sessionCount || 0) + 1;

// Save updated count immediately (even if we don't run the full check)
try {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(healthStatePath, JSON.stringify(healthState, null, 2), 'utf8');
} catch {}

// Exit early if not time to run
if (healthState.sessionCount < SESSIONS_BETWEEN_RUNS) {
  process.exit(0);
}

// Time to run the health check
function appendLog(msg) {
  try { fs.appendFileSync(logPath, msg, 'utf8'); } catch {}
}

// Gather all topic files and their contents
let topicFiles = [];
try {
  topicFiles = fs.readdirSync(topicsDir)
    .filter(f => f.endsWith('.md'))
    .sort();
} catch {}

if (topicFiles.length === 0) {
  // Nothing to audit — reset and exit
  healthState.lastRun = new Date().toISOString();
  healthState.sessionCount = 0;
  fs.writeFileSync(healthStatePath, JSON.stringify(healthState, null, 2), 'utf8');
  process.exit(0);
}

const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
appendLog(`\n## ${timestamp} — Memory Health Check\n`);
appendLog(`Auditing ${topicFiles.length} topic files after ${healthState.sessionCount} sessions\n`);

// Build topic file contents for the prompt
const topicContents = topicFiles.map(f => {
  let content = '(unreadable)';
  try { content = fs.readFileSync(path.join(topicsDir, f), 'utf8').trim(); } catch {}
  return `### memory/topics/${f}\n${content}`;
}).join('\n\n');

// ── Pass 1: Audit ──────────────────────────────────────────────────────────

const pass1Prompt = `Audit the following memory topic files for a software project.
For each file, identify:
- Outdated information (things that have likely changed)
- Contradictions between files
- Redundancy (same info in multiple files)
- Missing important context
- Anything too vague to be useful

Topic files to audit: ${topicFiles.map(f => `memory/topics/${f}`).join(', ')}

${topicContents}

Write your audit as a structured critique. Be specific about what to fix in which file.`;

const pass1Start = Date.now();
const pass1Result = spawnSync('claude', [
  '-p',
  '--input-format', 'text',
  '--output-format', 'text',
  '--model', 'haiku',
  '--max-budget-usd', '0.05',
  '--no-session-persistence',
], {
  input: pass1Prompt,
  cwd: projectDir,
  timeout: 90000,
  encoding: 'utf8',
  windowsHide: true,
});

const pass1Elapsed = ((Date.now() - pass1Start) / 1000).toFixed(1);
const pass1Status = pass1Result.status === 0 ? '✓ done' : `✗ error (exit ${pass1Result.status})`;
appendLog(`Health Pass 1 (audit): ${pass1Status} in ${pass1Elapsed}s\n`);

const auditOutput = (pass1Result.stdout || '').trim();

if (!auditOutput || pass1Result.status !== 0) {
  appendLog('Health check aborted: Pass 1 produced no output\n');
  // Still reset the counter so we don't retry immediately
  healthState.lastRun = new Date().toISOString();
  healthState.sessionCount = 0;
  fs.writeFileSync(healthStatePath, JSON.stringify(healthState, null, 2), 'utf8');
  process.exit(0);
}

// ── Pass 2: Fix ────────────────────────────────────────────────────────────

const pass2Prompt = `Based on this audit of memory topic files:

${auditOutput}

Current file contents to fix:
${topicContents}

Now update the topic files to fix the identified issues.
Rules:
- Remove outdated info
- Resolve contradictions
- Eliminate redundancy (keep the most specific version)
- Add missing context if you know it from the files
- Keep each file under 120 lines

Make targeted edits — don't rewrite files that don't need changes.`;

const pass2Start = Date.now();
const pass2Result = spawnSync('claude', [
  '-p',
  '--input-format', 'text',
  '--allowedTools', 'Read,Write,Edit,Glob',
  '--model', 'haiku',
  '--max-budget-usd', '0.08',
  '--permission-mode', 'acceptEdits',
  '--no-session-persistence',
], {
  input: pass2Prompt,
  cwd: projectDir,
  timeout: 120000,
  encoding: 'utf8',
  windowsHide: true,
});

const pass2Elapsed = ((Date.now() - pass2Start) / 1000).toFixed(1);
const pass2Status = pass2Result.status === 0 ? '✓ done' : `✗ error (exit ${pass2Result.status})`;
appendLog(`Health Pass 2 (fix): ${pass2Status} in ${pass2Elapsed}s\n`);

// Reset health state
healthState.lastRun = new Date().toISOString();
healthState.sessionCount = 0;
try {
  fs.writeFileSync(healthStatePath, JSON.stringify(healthState, null, 2), 'utf8');
} catch {}

appendLog(`Health check complete. Next run in ${SESSIONS_BETWEEN_RUNS} sessions.\n`);
