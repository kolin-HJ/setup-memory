#!/usr/bin/env node
/**
 * Memory Updater — Background AI Memory Maintenance (Two-Pass Recursive)
 *
 * Spawned by session-end.js after every session. Reads the session transcript,
 * extracts new technical discoveries, and updates memory topic files.
 *
 * Uses two sequential `claude -p` calls with haiku model:
 *   Pass 1: Extract new facts from transcript into topic files
 *   Pass 2: Review Pass 1 output, fix gaps and errors (recursive self-critique)
 *
 * Based on "Test-time Recursive Thinking" research (Feb 2026) — models produce
 * significantly better output when reviewing their own work.
 *
 * Uses `claude -p` with haiku model (fast + cheap ~$0.05-0.10/session total).
 * Runs fully detached — session ends immediately, this finishes in background.
 *
 * PORTABLE: All paths passed as arguments — no hardcoded values.
 *
 * Usage: node memory-updater.js <transcriptPath> <projectDir> <memoryDir>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [,, transcriptPath, projectDir, memoryDir] = process.argv;

if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

let messages = [];
try {
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)) {
    try { messages.push(JSON.parse(line)); } catch {}
  }
} catch {
  process.exit(0);
}

if (messages.length === 0) process.exit(0);

// Extract conversation (last 60 messages, text only)
const conversationLines = [];
for (const entry of messages.slice(-60)) {
  const msg = entry.message || entry;
  if (!msg.role || !['user', 'assistant'].includes(msg.role)) continue;
  const rawContent = msg.content || '';
  let text = typeof rawContent === 'string'
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.filter(c => c.type === 'text').map(c => c.text || '').join('\n')
      : '';
  text = text.trim();
  if (!text || text.startsWith('[Tool') || text.startsWith('{"')) continue;
  conversationLines.push(`${msg.role.toUpperCase()}: ${text.slice(0, 600)}`);
}

if (conversationLines.length < 3) process.exit(0);

// Discover existing topic files
const topicsDir = path.join(memoryDir, 'topics');
let existingTopics = [];
try {
  existingTopics = fs.readdirSync(topicsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => `memory/topics/${f}`);
} catch {}

const logPath = path.join(memoryDir, 'sessions', 'updater-log.md');
const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

function appendLog(msg) {
  try {
    fs.appendFileSync(logPath, msg, 'utf8');
  } catch {}
}

// Helper: get mtime (ms) for a file, 0 if missing
function getMtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

// Snapshot mtimes of all topic files before Pass 1
function snapshotTopicMtimes() {
  const snap = {};
  try {
    const files = fs.readdirSync(topicsDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      snap[f] = getMtime(path.join(topicsDir, f));
    }
  } catch {}
  return snap;
}

// Determine which topic files were modified after Pass 1
function getModifiedTopics(before) {
  const modified = [];
  try {
    const files = fs.readdirSync(topicsDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const current = getMtime(path.join(topicsDir, f));
      if (!before[f] || current > before[f]) {
        modified.push(`memory/topics/${f}`);
      }
    }
  } catch {}
  return modified;
}

// ── Pass 1: Extract new facts ──────────────────────────────────────────────

appendLog(`\n## ${timestamp} — Pass 1 start\n`);
const pass1Start = Date.now();

const pass1Prompt = `You are maintaining persistent memory files for a software project. Your job is to update topic files in memory/topics/ with verified technical facts from this coding session.

EXISTING TOPIC FILES: ${existingTopics.length > 0 ? existingTopics.join(', ') : '(none yet)'}

SESSION CONVERSATION:
${conversationLines.join('\n\n')}

YOUR TASK:
1. Read the conversation above
2. Identify NEW confirmed technical facts:
   - Code paths (function names, file locations, how things connect)
   - Schema details (database shapes, API structures, field names)
   - Bugs fixed and their root causes
   - Architectural decisions or patterns established
   - Non-obvious behaviors or gotchas discovered
3. Update relevant topic file(s) with these facts
4. If a NEW domain was heavily worked on (not covered by existing topics), CREATE memory/topics/{domain}.md

RULES:
- ONLY write facts confirmed in this session — no speculation
- Read existing topic files first to avoid duplication
- Keep each file under 120 lines using concise bullet points
- New file header format:
  # {Domain} — Deep Context
  *Memory type: PERMANENT | Update when: {condition}*
- Include specific file paths and function names for code facts
- If nothing genuinely new was discovered, make no changes`;

const mtimesBefore = snapshotTopicMtimes();

const pass1Result = spawnSync('claude', [
  '-p',
  '--input-format', 'text',
  '--allowedTools', 'Read,Write,Edit,Glob',
  '--model', 'haiku',
  '--max-budget-usd', '0.10',
  '--permission-mode', 'acceptEdits',
  '--no-session-persistence',
], {
  input: pass1Prompt,
  cwd: projectDir,
  timeout: 180000,
  encoding: 'utf8',
  windowsHide: true,
});

const pass1Elapsed = ((Date.now() - pass1Start) / 1000).toFixed(1);
const pass1Status = pass1Result.status === 0 ? '✓ done' : `✗ error (exit ${pass1Result.status})`;
appendLog(`Pass 1: ${pass1Status} in ${pass1Elapsed}s\n${pass1Result.stderr?.slice(0, 200) || ''}\n`);

// ── Pass 2: Self-critique and refine ──────────────────────────────────────

const modifiedTopics = getModifiedTopics(mtimesBefore);

if (modifiedTopics.length > 0) {
  appendLog(`Pass 2 start — reviewing ${modifiedTopics.length} modified file(s): ${modifiedTopics.join(', ')}\n`);
  const pass2Start = Date.now();

  const pass2Prompt = `You just ran a memory update pass on a coding session transcript.
Review what you wrote in the following topic files: ${modifiedTopics.join(', ')}

For each file you updated, ask yourself:
- Did I miss any important facts from the session?
- Did I write anything speculative or unconfirmed?
- Did I add unnecessary noise or obvious information?
- Are there contradictions with existing content?
- Is anything now outdated based on what happened this session?

Then make targeted corrections and additions. Be concise — only change what genuinely needs improvement.

SESSION CONVERSATION (for reference):
${conversationLines.join('\n\n')}`;

  const pass2Result = spawnSync('claude', [
    '-p',
    '--input-format', 'text',
    '--allowedTools', 'Read,Write,Edit,Glob',
    '--model', 'haiku',
    '--max-budget-usd', '0.05',
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
  appendLog(`Pass 2: ${pass2Status} in ${pass2Elapsed}s\n${pass2Result.stderr?.slice(0, 200) || ''}\n`);
} else {
  appendLog(`Pass 2: skipped — no topic files were modified in Pass 1\n`);
}

appendLog(`Total budget cap: $0.15\n`);
