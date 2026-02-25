# Architecture Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `hooks/*.js` the single canonical source of generic, portable hook code, fix the Stop hook runtime bug (blocking spawnSync), remove hardcoded project-specific domain names, and eliminate the ~400 lines of embedded JS from `commands/setup-memory.md`.

**Architecture:** Rename `plugin/hooks/` → `hooks/`, rewrite the hook files to be fully generic (dynamic topic detection from existing files, all background jobs detached), then rewrite `commands/setup-memory.md` to glob-and-copy from the plugin's `hooks/` directory instead of embedding code. Update metadata and README to match.

**Tech Stack:** Node.js (hooks), Markdown (commands/README), JSON (plugin metadata)

---

## Critical Context

The `plugin/hooks/` files are NOT currently generic — they contain hardcoded domain keywords (`demandplan`, `dashboard`, `bigquery`) from the author's personal project. The generic versions of these functions already exist as embedded code in `commands/setup-memory.md`. The plan is to:
1. Fix the source hook files to be generic (using `commands/setup-memory.md` embedded versions as reference)
2. Make all three background jobs detached in `session-end.js`
3. Rename `plugin/hooks/` → `hooks/`
4. Rewrite `commands/setup-memory.md` to copy from hooks/ instead of embedding code

---

### Task 1: Fix `session-start.js` — replace hardcoded domains with generic topic hints

**Files:**
- Modify: `plugin/hooks/session-start.js`

The current file has a `detectActiveDomains()` function hardcoded with project-specific keywords. Replace the entire file with the generic version that reads existing topic files dynamically.

**Step 1: Write the new file**

Replace `plugin/hooks/session-start.js` with exactly this content:

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

**Step 2: Verify no hardcoded domain names remain**

Run:
```bash
grep -n "demandplan\|dashboard\|bigquery\|purchaseplan" plugin/hooks/session-start.js
```
Expected: no output (zero matches)

**Step 3: Commit**

```bash
git add plugin/hooks/session-start.js
git commit -m "fix: replace hardcoded domains with generic topic hints in session-start"
```

---

### Task 2: Fix `session-end.js` — generic topic detection + all jobs detached

**Files:**
- Modify: `plugin/hooks/session-end.js`

Three problems to fix simultaneously:
1. Missing `assistantContent` extraction (needed for generic topic detection)
2. Hardcoded domain detection → generic `detectPendingTopics()` that reads existing topic files
3. Synthesizer and health checker use `spawnSync` (blocking) → change to `spawn` + `unref()` (detached)
4. Add spawn log line to `updater-log.md` so all three jobs are visible in one place

**Step 1: Write the new file**

Replace `plugin/hooks/session-end.js` with exactly this content:

```javascript
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

// Log that all background jobs are about to be spawned
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
```

**Step 2: Verify no hardcoded domains and no spawnSync**

```bash
grep -n "demandplan\|dashboard\|bigquery\|purchaseplan\|spawnSync" plugin/hooks/session-end.js
```
Expected: no output

**Step 3: Commit**

```bash
git add plugin/hooks/session-end.js
git commit -m "fix: generic topic detection + all background jobs detached in session-end"
```

---

### Task 3: Rename `plugin/hooks/` → `hooks/`

**Step 1: Git move the directory**

```bash
cd /c/Users/Kolin/documents/GitHub/setup-memory
git mv plugin/hooks hooks
```

**Step 2: Verify**

```bash
ls hooks/
```
Expected: `memory-health.js  memory-updater.js  session-end.js  session-start.js  session-synthesizer.js`

```bash
ls plugin/
```
Expected: empty or directory gone. If `plugin/` is now empty:
```bash
rmdir plugin
```

**Step 3: Verify git status looks clean**

```bash
git status
```
Expected: staged renames from `plugin/hooks/*.js` → `hooks/*.js`, possibly `plugin/` deleted.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rename plugin/hooks/ to hooks/ at repo root"
```

---

### Task 4: Rewrite `commands/setup-memory.md`

**Files:**
- Modify: `commands/setup-memory.md`

This is the largest change. Remove all embedded JS code blocks (~400 lines). Replace Steps 4–6c (which write hook code inline) with two new steps: find the plugin hooks directory, then copy each file.

**Step 1: Write the new file**

Replace the entire content of `commands/setup-memory.md` with:

```markdown
# Setup Intelligent Memory System

Sets up a self-maintaining memory system for Claude Code. After setup, every session start automatically injects your live git context (branch, recent commits, modified files, AI-synthesized session briefing) into Claude's system prompt. Every session end spawns three background AI processes: a two-pass recursive memory updater, a session synthesizer that generates a rich briefing for next session, and a periodic health checker that audits topic files every 10 sessions.

Over time, `memory/topics/` files accumulate verified facts about your codebase — schemas, code paths, bugs fixed, architectural decisions — making Claude progressively smarter about your project without any manual work.

## Usage
`/setup-memory`

Run once from inside a git repository. Re-running updates hooks to the latest plugin version.

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

### Step 4 — Find the plugin hooks directory

Use the Glob tool to search for `session-start.js` under the Claude plugins directory. The pattern to use:

- **Mac/Linux:** glob pattern `~/.claude/plugins/**/*setup-memory*/hooks/session-start.js`
- **Windows:** glob pattern `C:/Users/*/. claude/plugins/**/*setup-memory*/hooks/session-start.js`

The directory containing `session-start.js` is the plugin hooks directory. Call it `<plugin-hooks-dir>`.

If the glob returns no results, try a broader search: glob for `session-start.js` under `~/.claude/plugins/` with no path filter, then find the one in a `setup-memory` path.

### Step 5 — Copy hook files to the project memory directory

Read each of these files from `<plugin-hooks-dir>/` and write it to `<memory-dir>/hooks/`:

- `session-start.js`
- `session-end.js`
- `memory-updater.js`
- `session-synthesizer.js`
- `memory-health.js`

Copy the file contents exactly — do not modify them.

If hook files already exist in `<memory-dir>/hooks/`, overwrite them (this updates to the latest plugin version).

### Step 6 — Create `<memory-dir>/MEMORY.md`

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
```

### Step 7 — Update `.claude/settings.local.json`

**Read the entire existing file first.** Preserve ALL existing content. Only add the new `SessionStart` and `Stop` hook entries.

Use the **full absolute path** to the memory hooks (not `~` — expand completely). Use forward slashes on all platforms.

**If the file has existing hooks**, merge carefully — preserve all other hook events:
```json
{
  "permissions": { "allow": ["...existing entries..."] },
  "hooks": {
    "PostToolUse": ["...preserve existing exactly..."],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /full/absolute/path/memory/hooks/session-start.js", "timeout": 15 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /full/absolute/path/memory/hooks/session-end.js", "timeout": 45 }] }]
  }
}
```

**If the file does not exist**, create it:
```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node /full/absolute/path/memory/hooks/session-start.js", "timeout": 15 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /full/absolute/path/memory/hooks/session-end.js", "timeout": 45 }] }]
  }
}
```

### Step 8 — Test both hooks

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

### Step 9 — Report back

Tell the user:
1. The full memory directory path
2. Confirmation both hooks tested successfully (show actual output)
3. A one-line summary of their `MEMORY.md`
4. **"Next time you open Claude Code in this project, you'll see a '🧠 Auto-Injected Session Context' block automatically showing your git state and last session summary."**
5. **"After each session ends, three background processes run: a two-pass memory updater, a session synthesizer (generates a briefing for your next cold-start), and a periodic health checker every 10 sessions. Check `memory/sessions/updater-log.md` to see them working."**
6. Cost: ~$0.05–0.15 per session (memory updater + session synthesizer, capped at $0.18 total)

---

## Rules
- Do NOT skip Step 8 — hooks that fail produce no error; the system silently stops working
- Do NOT use `~` in hook command paths in settings.local.json — always expand to full absolute path
- Do NOT create `MEMORY.md` if it already exists — skip Step 6
- Do NOT remove any existing keys from `settings.local.json` — only add new hook entries
- If all 5 hook files already exist in `<memory-dir>/hooks/`, still copy them (Step 5) — this updates to latest plugin version
```

**Step 2: Verify no inline JS code blocks remain**

```bash
grep -c "function\|const fs\|require(" commands/setup-memory.md
```
Expected: `0`

**Step 3: Commit**

```bash
git add commands/setup-memory.md
git commit -m "refactor: remove embedded JS from setup command, use glob-and-copy from hooks/"
```

---

### Task 5: Update `.claude-plugin/plugin.json` and `README.md`

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `README.md`

**Step 1: Update plugin.json**

Replace the content of `.claude-plugin/plugin.json` with:

```json
{
  "name": "setup-memory",
  "version": "2.0.0",
  "description": "Sets up a self-maintaining AI memory system for Claude Code. Session start injects git context + AI-synthesized briefing. Session end spawns three background jobs: two-pass recursive memory updater, session synthesizer, and periodic health checker.",
  "author": {
    "name": "Kolin",
    "url": "https://github.com/kolin-hj"
  },
  "repository": "https://github.com/kolin-hj/setup-memory",
  "license": "MIT",
  "keywords": ["memory", "productivity", "sessions", "context", "git"]
}
```

**Step 2: Update README.md Files Created section**

Find and replace the `## Files created` section in `README.md` with:

```markdown
## Files created

```
memory/
  MEMORY.md                  ← Auto-loaded index (< 150 lines)
  hooks/
    session-start.js         ← SessionStart hook
    session-end.js           ← Stop hook
    memory-updater.js        ← Background AI updater (2-pass recursive)
    session-synthesizer.js   ← Generates briefing at session end
    memory-health.js         ← Periodic topic file health check
  topics/                    ← Domain knowledge (auto-created per session)
  sessions/
    latest.md                ← Last session summary
    briefing.md              ← AI-synthesized briefing for next session
    YYYY-MM-DD.md            ← Historical logs
    updater-log.md           ← Background AI run history
    health-state.json        ← Health check session counter
```
```

**Step 3: Update README.md "What /setup-memory does" section**

Find and replace the `## What \`/setup-memory\` does` section with:

```markdown
## What `/setup-memory` does

When you run `/setup-memory` inside Claude Code, it will:

1. Verify you're inside a git repository
2. Find the hook files inside the plugin installation directory
3. Copy all 5 hook files into your project's memory directory
4. Write a starter `MEMORY.md` tailored to your tech stack (skipped if one exists)
5. Update `.claude/settings.local.json` with `SessionStart` and `Stop` hooks
6. Test both hooks and confirm they work before finishing

Re-running `/setup-memory` on an already-set-up project updates the hooks to the latest plugin version.
```

**Step 4: Commit both**

```bash
git add .claude-plugin/plugin.json README.md
git commit -m "docs: bump to v2.0.0, update README and plugin.json for new architecture"
```

---

### Task 6: Push and verify

**Step 1: Push to main**

```bash
git push origin main
```

**Step 2: Final check — no hardcoded domains anywhere in hooks/**

```bash
grep -rn "demandplan\|dashboard\|bigquery\|purchaseplan\|pab" hooks/
```
Expected: no output

**Step 3: Verify hooks/ is at root, plugin/ is gone**

```bash
ls hooks/ && ls plugin/ 2>&1
```
Expected: 5 js files listed, then an error saying `plugin/` doesn't exist

**Step 4: Verify commands/setup-memory.md has no embedded JS**

```bash
grep -c "require(\|function \|const fs" commands/setup-memory.md
```
Expected: `0`
