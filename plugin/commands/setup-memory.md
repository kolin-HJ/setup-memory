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

Write this file with exactly this content:

```javascript
#!/usr/bin/env node
/**
 * SessionStart Hook — Auto-Injected Context
 *
 * Reads git state + last session log to give Claude instant awareness of:
 * - What branch/work is in progress
 * - What files are modified
 * - What was worked on in the last session
 * - Any pending memory updates flagged during last session
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

const lastSession = readFile('sessions/latest.md');
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
if (lastSession) parts.push(`**Last Session Summary:**\n${lastSession}`);
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

Write this file with exactly this content:

```javascript
#!/usr/bin/env node
/**
 * Stop Hook — Session Activity Capture
 *
 * Runs when a Claude Code session ends. Records what was worked on and
 * spawns a background AI process to update memory topic files.
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

// Spawn background AI memory updater
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

process.stdout.write(JSON.stringify({ decision: 'approve' }));
```

### Step 6 — Write `<memory-dir>/hooks/memory-updater.js`

Write this file with exactly this content:

```javascript
#!/usr/bin/env node
/**
 * Memory Updater — Background AI Memory Maintenance
 *
 * Spawned by session-end.js after every session. Reads the session transcript,
 * extracts new technical discoveries, and updates memory topic files.
 *
 * Uses `claude -p` with haiku model (fast + cheap ~$0.02-0.08/session).
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

const prompt = `You are maintaining persistent memory files for a software project. Your job is to update topic files in memory/topics/ with verified technical facts from this coding session.

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

const result = spawnSync('claude', [
  '-p',
  '--input-format', 'text',
  '--allowedTools', 'Read,Write,Edit,Glob',
  '--model', 'haiku',
  '--max-budget-usd', '0.10',
  '--permission-mode', 'acceptEdits',
  '--no-session-persistence',
], {
  input: prompt,
  cwd: projectDir,
  timeout: 180000,
  encoding: 'utf8',
  windowsHide: true,
});

// Log result for debugging
const logPath = path.join(memoryDir, 'sessions', 'updater-log.md');
const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const status = result.status === 0 ? '✓ updated' : `✗ error (exit ${result.status})`;
try {
  fs.appendFileSync(logPath, `\n## ${timestamp} — ${status}\n${result.stderr?.slice(0, 200) || ''}\n`, 'utf8');
} catch {}
```

### Step 7 — Create or restructure `<memory-dir>/MEMORY.md`

This step always runs — whether MEMORY.md exists or not.

**First**, scan the project: read `package.json`, top-level folder names, `.claude/commands/` if present, and any existing `MEMORY.md` or `CLAUDE.md` files. Collect all useful information: tech stack, existing rules, custom commands, terminology, known patterns.

**If MEMORY.md already exists**, read its full contents. Extract everything valuable from it (rules, commands, patterns, terminology, project-specific notes) and carry it forward into the new version. Do not discard information — restructure it into the format below.

**Then write a single clean MEMORY.md** using this structure. Keep it under **150 lines** — this file is auto-loaded into every session and the hard limit is 200 lines (anything beyond line 200 is silently ignored).

```markdown
# Auto Memory — [Project Name]

## Interaction Style (CRITICAL — follow on EVERY prompt)
- **Code immediately** — skip analysis/planning unless explicitly asked
- **Scope = exactly what was asked** — no extra UI, no refactoring, no comments on unchanged code
- **Verify before coding** — read relevant files before editing; never guess at structure
- **No speculation** — only write confirmed facts; ask if unsure
- [Carry forward any project-specific rules from the existing MEMORY.md]

## Tech Stack
[3-5 bullet points covering framework, backend, database, external APIs, key libraries]

## Key Commands
| Command | Purpose |
|---------|---------|
| [List any custom slash commands found in .claude/commands/ — include all of them] |

## Topic Files (load when working in these areas)
*Auto-maintained by background AI after each session. Read the relevant file before starting work in that domain.*
[List any existing topic files found in memory/topics/, with one-line descriptions]
- New topic files are created automatically as new domains are worked on

## Session Memory (auto-updated every session end)
- `memory/sessions/latest.md` — what was worked on last session
- `memory/sessions/pending-updates.md` — topics flagged as needing review
- `memory/sessions/updater-log.md` — background AI updater run history

## Auto-Maintenance
After every session, a background `claude -p haiku` process reads the full session transcript and updates `memory/topics/*.md` with new discoveries. During sessions, also update topic files immediately when confirming new facts (schema details, code paths, bugs fixed, gotchas).

[Carry forward any Terminology, Agent rules, or other sections from the existing MEMORY.md that don't fit above]

## Current Date
Today's date is [TODAY'S DATE].
```

### Step 8 — Update `.claude/settings.local.json`

**Read the entire existing file first.** Preserve ALL existing content — `permissions`, `enableAllProjectMcpServers`, `enabledMcpjsonServers`, and every existing hook entry. Only add the new `SessionStart` and `Stop` entries.

Use the **full absolute path** to the memory hooks (not `~` — expand it completely). Use forward slashes on all platforms.

**If the file has existing hooks**, merge carefully:
```json
{
  "permissions": { "allow": ["...existing entries..."] },
  "hooks": {
    "PostToolUse": ["...preserve existing PostToolUse exactly..."],
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
5. **"After each session ends, a background process updates `memory/topics/` with new discoveries. Check `memory/sessions/updater-log.md` to see it working."**
6. Cost: ~$0.02–0.08 per session for the background haiku updater, capped at $0.10

---

## Rules
- Do NOT skip Step 9 — hooks that fail produce no error; the system silently stops working
- Do NOT use `~` in hook command paths in settings.local.json — always expand to full absolute path
- Do NOT overwrite an existing `MEMORY.md` — skip Step 7 if the file already exists
- Do NOT remove any existing keys from `settings.local.json` — only add new hook entries
- If all 3 hook files already exist, skip Steps 4–6 and go straight to Step 9 to verify they still work
