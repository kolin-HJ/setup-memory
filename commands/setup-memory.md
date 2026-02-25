# Setup Intelligent Memory System

Sets up a self-maintaining memory system for Claude Code. After setup, every session start automatically injects your live git context (branch, recent commits, modified files, last session summary) into Claude's system prompt. Every session end runs a background AI process that reads the full transcript and updates topic files with new technical discoveries.

Over time, `memory/topics/` files accumulate verified facts about your codebase — schemas, code paths, bugs fixed, architectural decisions — making Claude progressively smarter about your project without any manual work.

## Usage
`/setup-memory`

Run once from inside a git repository. No arguments needed.

---

## Steps

### Step 1 — Verify git repository
Run `git rev-parse --show-toplevel`. If it fails, stop and tell the user: "You must run /setup-memory from inside a git repository."

### Step 2 — Find the memory directory
Claude Code automatically creates a persistent memory directory for each project at:
```
~/.claude/projects/<encoded-path>/memory/
```

Where `<encoded-path>` is the absolute project root with every path separator and colon replaced by `-`:

**Windows example:**
- Project root: `C:\Users\alice\documents\GitHub\my-app`
- Encoded: `C--Users-alice-documents-GitHub-my-app`
- Memory dir: `C:\Users\alice\.claude\projects\C--Users-alice-documents-GitHub-my-app\memory\`

**Mac/Linux example:**
- Project root: `/Users/alice/projects/my-app`
- Encoded: `-Users-alice-projects-my-app` (leading slash becomes leading dash)
- Memory dir: `~/.claude/projects/-Users-alice-projects-my-app/memory/`

Note: Every separator character produces its own `-`. `C:\Users\` becomes `C--Users-` because `:` → `-` and `\` → `-` are separate replacements that don't merge.

Verify this directory exists. If it doesn't, create it now with `mkdir -p`.

### Step 3 — Create subdirectories
```
<memory-dir>/hooks/
<memory-dir>/topics/
<memory-dir>/sessions/
```

### Step 4 — Write `<memory-dir>/hooks/session-start.js`

Reads git state + synthesized session briefing (when available) or last session log to inject context. When `sessions/briefing.md` exists (AI-synthesized by the session synthesizer), it is used instead of the raw session log for richer cold-start context.

Write this file with exactly this content:

```javascript
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

function getTopicHints(modifiedFiles) {
  try {
    const topicsDir = path.join(MEMORY_DIR, 'topics');
    const topics = fs.readdirSync(topicsDir).filter(f => f.endsWith('.md'));
    if (topics.length === 0) return '';
    const f = modifiedFiles.toLowerCase();
    const relevant = topics.filter(t => {
      const keyword = t.replace('.md', '').replace(/-/g, '');
      const keyword2 = t.replace('.md', '');
      return f.includes(keyword) || f.includes(keyword2);
    });
    if (relevant.length > 0) {
      return `\n**Relevant topic files:** ${relevant.map(t => `\`memory/topics/${t}\``).join(', ')} — read for deep context`;
    }
    return `\n**Topic files available:** ${topics.map(t => `\`memory/topics/${t}\``).join(', ')}`;
  } catch {
    return '';
  }
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

const topicHints = getTopicHints(modifiedFiles + lastDiffFiles);

const parts = [];
if (branch) parts.push(`**Branch:** \`${branch}\``);
if (recentCommits) parts.push(`**Recent Commits (last 7):**\n\`\`\`\n${recentCommits}\n\`\`\``);
if (modifiedFiles) parts.push(`**Uncommitted Changes:**\n\`\`\`\n${modifiedFiles}\n\`\`\``);
else parts.push('**Uncommitted Changes:** (working tree clean)');
if (topicHints) parts.push(topicHints);
if (lastSession) parts.push(`${briefingLabel}\n${lastSession}`);
if (pendingUpdates) parts.push(`**⚠ Pending Memory Updates (from last session):**\n${pendingUpdates}`);

const context = `## 🧠 Auto-Injected Session Context\n*Generated automatically from git state and session history.*\n\n${parts.join('\n\n')}`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
}));
```

### Step 5 — Write `<memory-dir>/hooks/session-end.js`

Captures session activity, spawns the background memory updater (fire-and-forget), then synchronously runs the session synthesizer (~5-10s, generates a briefing for next session start) and the periodic memory health checker (runs every 10 sessions).

Write this file with exactly this content:

```javascript
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

function detectPendingTopics(changedFiles, assistantContent) {
  const pending = new Set();
  try {
    const topicsDir = path.join(MEMORY_DIR, 'topics');
    const existing = fs.readdirSync(topicsDir).filter(f => f.endsWith('.md'));
    const combined = (changedFiles + ' ' + assistantContent).toLowerCase();
    for (const topicFile of existing) {
      const keyword = topicFile.replace('.md', '').replace(/-/g, '');
      const keyword2 = topicFile.replace('.md', '');
      if (combined.includes(keyword) || combined.includes(keyword2)) {
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
```

### Step 6 — Write `<memory-dir>/hooks/memory-updater.js`

This updater now uses **two-pass recursive processing**: Pass 1 extracts new facts from the transcript into topic files; Pass 2 reviews what Pass 1 wrote and makes targeted corrections and additions. Only files actually modified in Pass 1 are reviewed in Pass 2. Based on "Test-time Recursive Thinking" research (Feb 2026).

Write this file with exactly this content:

```javascript
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
```

### Step 6b — Write `<memory-dir>/hooks/session-synthesizer.js`

Generates a pre-synthesized briefing at session end. Reads `sessions/latest.md` and the last 10 user messages from the transcript, then runs `claude -p haiku` to produce a concise bullet-point briefing written to `sessions/briefing.md`. This briefing is used by session-start.js next session for richer context.

Write this file with exactly this content:

```javascript
#!/usr/bin/env node
/**
 * Session Synthesizer — Pre-Computed Briefing for Next Session
 *
 * Runs synchronously at session END (triggered by session-end.js).
 * Generates a concise AI-synthesized briefing so session START gets rich
 * context instead of raw git state.
 *
 * Reads:
 *   - sessions/latest.md (what was worked on)
 *   - Last 10 user messages from the transcript
 *
 * Writes: sessions/briefing.md
 *
 * Uses `claude -p haiku` (~5-10s, fast). Runs synchronously so session-end.js
 * waits for it before finishing.
 *
 * PORTABLE: All paths passed as arguments — no hardcoded values.
 *
 * Usage: node session-synthesizer.js <transcriptPath> <projectDir> <memoryDir>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [,, transcriptPath, projectDir, memoryDir] = process.argv;

const sessionsDir = path.join(memoryDir, 'sessions');
const briefingPath = path.join(sessionsDir, 'briefing.md');

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

// Read latest session summary
const latestSession = readFile(path.join(sessionsDir, 'latest.md'));
if (!latestSession) process.exit(0);

// Extract last 10 user messages from transcript (first 200 chars each)
let userMessages = [];
if (transcriptPath && fs.existsSync(transcriptPath)) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || entry;
        if (msg.role !== 'user') continue;
        const rawContent = msg.content || '';
        let text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.filter(c => c.type === 'text').map(c => c.text || '').join(' ')
            : '';
        text = text.trim().slice(0, 200);
        if (text && !text.startsWith('[Tool') && !text.startsWith('{"')) {
          userMessages.push(text);
        }
      } catch {}
    }
    userMessages = userMessages.slice(-10);
  } catch {}
}

const prompt = `You are generating a session briefing for the NEXT coding session on this project.

SESSION ACTIVITY:
${latestSession}

RECENT USER REQUESTS (what was actually being built/fixed):
${userMessages.length > 0 ? userMessages.map((m, i) => `${i + 1}. ${m.replace(/\n/g, ' ')}`).join('\n') : '(not available)'}

TASK: Write a concise briefing (max 10 bullet points) for the developer opening this project tomorrow.
Focus on:
- Current state: what was completed, what's in progress, what's broken
- Open questions or decisions that need to be made
- Gotchas and non-obvious things discovered this session
- What to do FIRST when returning to this work
- Any bugs introduced or not yet fully fixed

Format as tight bullet points. Be specific — include function names, file paths, exact error messages where relevant. Skip anything obvious.`;

const result = spawnSync('claude', [
  '-p',
  '--input-format', 'text',
  '--output-format', 'text',
  '--model', 'haiku',
  '--max-budget-usd', '0.03',
  '--no-session-persistence',
], {
  input: prompt,
  cwd: projectDir,
  timeout: 60000,
  encoding: 'utf8',
  windowsHide: true,
});

if (result.status === 0 && result.stdout && result.stdout.trim()) {
  const generated = result.stdout.trim();
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const briefingContent = `<!-- Generated: ${timestamp} -->\n${generated}\n`;
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(briefingPath, briefingContent, 'utf8');
  } catch {}
}
```

### Step 6c — Write `<memory-dir>/hooks/memory-health.js`

Periodic recursive two-pass review of all topic files. Checks `sessions/health-state.json` and only runs every 10 sessions. Pass 1 audits all topic files for quality issues; Pass 2 makes targeted fixes based on the audit. Resets session count after running.

Write this file with exactly this content:

```javascript
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
  const content = (() => {
    try { return fs.readFileSync(path.join(topicsDir, f), 'utf8').trim(); } catch { return '(unreadable)'; }
  })();
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
```

### Step 7 — Create `<memory-dir>/MEMORY.md`

**Only run this step if `MEMORY.md` does NOT already exist** — never overwrite a user's existing memory file.

Scan the project first: read `package.json`, top-level folder names, `.claude/commands/` if present, and any `CLAUDE.md` files. Collect tech stack, custom commands, and key patterns.

Write a starter `MEMORY.md` under **150 lines** using this structure:

```markdown
# Auto Memory — [Project Name]

## Interaction Style (CRITICAL — follow on EVERY prompt)
- **Code immediately** — skip analysis/planning unless explicitly asked
- **Scope = exactly what was asked** — no extra UI, no refactoring, no comments on unchanged code
- **Verify before coding** — read relevant files before editing; never guess at structure
- **No speculation** — only write confirmed facts; ask if unsure

## Tech Stack
[3-5 bullet points covering framework, backend, database, external APIs, key libraries]

## Key Commands
| Command | Purpose |
|---------|---------|
| [List any custom slash commands found in .claude/commands/] |

## Topic Files (load when working in these areas)
*Auto-maintained by background AI after each session. Read the relevant file before starting work in that domain.*
- New topic files are created automatically as new domains are worked on

## Session Memory (auto-updated every session end)
- `memory/sessions/latest.md` — what was worked on last session
- `memory/sessions/briefing.md` — AI-synthesized briefing for next session start
- `memory/sessions/pending-updates.md` — topics flagged as needing review
- `memory/sessions/updater-log.md` — background AI updater run history

## Auto-Maintenance
After every session:
- A background `claude -p haiku` process reads the full session transcript and updates `memory/topics/*.md` with new discoveries (two-pass recursive: extract → self-critique)
- A session synthesizer generates `memory/sessions/briefing.md` for richer cold-start next session
- Every 10 sessions, a health checker audits and consolidates topic files

During sessions, also update topic files immediately when confirming new facts (schema details, code paths, bugs fixed, gotchas).

[Carry forward any Terminology, Agent rules, or other sections from the existing MEMORY.md that don't fit above]

## Current Date
Today's date is [TODAY'S DATE].
```

### Step 8 — Update `.claude/settings.local.json`

**Read the entire existing file first.** Preserve ALL existing content. Only add the new `SessionStart` and `Stop` hook entries.

Use the **full absolute path** to the memory hooks (not `~` — expand completely). Use forward slashes on all platforms.

**If the file has existing hooks**, merge carefully — preserve all other hook events:
```json
{
  "permissions": { "allow": ["...existing entries..."] },
  "hooks": {
    "PostToolUse": ["...preserve existing exactly..."],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /full/absolute/path/memory/hooks/session-start.js", "timeout": 15 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /full/absolute/path/memory/hooks/session-end.js", "timeout": 30 }] }]
  }
}
```

**If the file does not exist**, create it:
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /full/absolute/path/memory/hooks/session-start.js", "timeout": 15 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /full/absolute/path/memory/hooks/session-end.js", "timeout": 30 }] }]
  }
}
```

### Step 9 — Test both hooks

Run each hook directly and verify output:

**Test session-start:**
```bash
node /full/path/to/memory/hooks/session-start.js
```
Must output JSON with `"hookEventName": "SessionStart"` and `"additionalContext"` containing your git branch. If `node` is not found, run `where node` (Windows) or `which node` (Mac/Linux) and use the full path instead.

**Test session-end:**
```bash
node /full/path/to/memory/hooks/session-end.js
```
Must output exactly `{"decision":"approve"}`.

If either test fails, diagnose and fix before finishing.

### Step 10 — Report back

Tell the user:
1. The full memory directory path
2. Confirmation both hooks tested successfully (show actual output)
3. A one-line summary of their `MEMORY.md`
4. **"Next time you open Claude Code in this project, you'll see a '🧠 Auto-Injected Session Context' block automatically showing your git state and last session summary."**
5. **"After each session ends, a background process updates `memory/topics/` with new discoveries (two-pass recursive: extract → self-critique). Check `memory/sessions/updater-log.md` to see it working."**
6. **"A session synthesizer also runs at session end — it generates a concise `sessions/briefing.md` so your next cold-start gets an AI-summarized briefing instead of raw logs."**
7. **"Every 10 sessions, a recursive health check audits and consolidates all topic files to keep them accurate."**
8. Cost: ~$0.05–0.15 per session (memory updater + session synthesizer, capped at $0.18 total)

---

## Rules
- Do NOT skip Step 9 — hooks that fail produce no error; the system silently stops working
- Do NOT use `~` in hook command paths in settings.local.json — always expand to full absolute path
- Do NOT create `MEMORY.md` if it already exists — skip Step 7
- Do NOT remove any existing keys from `settings.local.json` — only add new hook entries
- If all 3 hook files already exist, skip Steps 4–6c and go straight to Step 9 to verify they still work
