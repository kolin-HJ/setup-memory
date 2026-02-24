# Setup Intelligent Memory System

Sets up a self-maintaining memory system for Claude Code that automatically learns your codebase over time. After setup, every session start injects live git context, and every session end runs a background AI process that reads the full transcript and updates topic files with new discoveries.

## Usage
`/setup-memory`

No arguments needed. Run once per project from inside the project directory.

## What Gets Created
- `memory/hooks/session-start.js` — SessionStart hook: injects git state + last session into every session
- `memory/hooks/session-end.js` — Stop hook: captures session activity, spawns background AI updater
- `memory/hooks/memory-updater.js` — Background claude -p haiku process that reads transcript and updates topic files
- `memory/topics/` — Domain-specific knowledge files (auto-created and updated after each session)
- `memory/sessions/` — Rolling session logs (latest.md always loaded at session start)
- `memory/MEMORY.md` — Lean index file (auto-loaded by Claude Code, stays under 100 lines)
- `.claude/settings.local.json` — Updated with SessionStart and Stop hook entries

## Steps

1. **Confirm you are in the project root** by running `git rev-parse --show-toplevel`. If this fails, stop and tell the user they must be inside a git repository.

2. **Find the auto-memory directory** — it follows the pattern `~/.claude/projects/<encoded-path>/memory/` where `<encoded-path>` is the absolute project path with path separators replaced by `-`. Compute this path:
   - Get the absolute project root from `git rev-parse --show-toplevel`
   - Encode it: replace all `/`, `\`, `:` with `-` (e.g. `C:\Users\name\project` → `C--Users-name-project`)
   - Full memory dir: `~/.claude/projects/<encoded>/memory/`
   - Verify this directory exists (Claude Code creates it automatically). If it doesn't exist yet, create it.

3. **Create the directory structure:**
   ```
   memory/hooks/
   memory/topics/
   memory/sessions/
   ```

4. **Write `memory/hooks/session-start.js`** with exactly this content:

```javascript
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MEMORY_DIR = path.join(__dirname, '..');

function getProjectDir() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return process.cwd(); }
}

const PROJECT_DIR = getProjectDir();

function exec(cmd) {
  try { return execSync(cmd, { cwd: PROJECT_DIR, timeout: 5000, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function readFile(relPath) {
  try { return fs.readFileSync(path.join(MEMORY_DIR, relPath), 'utf8').trim(); }
  catch { return ''; }
}

function detectActiveDomains(files) {
  const domains = new Set();
  const f = files.toLowerCase();
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
if (pendingUpdates) parts.push(`**Pending Memory Updates:**\n${pendingUpdates}`);

const context = `## Auto-Injected Session Context\n*Generated from git state and session history.*\n\n${parts.join('\n\n')}`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
}));
```

5. **Write `memory/hooks/session-end.js`** with exactly this content:

```javascript
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const MEMORY_DIR = path.join(__dirname, '..');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');

function getProjectDir() {
  try { return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { return process.cwd(); }
}

const PROJECT_DIR = getProjectDir();
function exec(cmd) {
  try { return execSync(cmd, { cwd: PROJECT_DIR, timeout: 5000, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

const now = new Date();
const dateStr = now.toISOString().split('T')[0];
const timeStr = now.toTimeString().slice(0, 5);

const branch = exec('git branch --show-current');
const recentCommits = exec('git log --oneline -5');
const modifiedFiles = exec('git diff --name-only HEAD');
const stagedFiles = exec('git diff --name-only --staged');
const allChangedFiles = [...new Set([...modifiedFiles.split('\n'), ...stagedFiles.split('\n')].filter(Boolean))].join('\n');

let userRequests = [];
let pendingMemoryTopics = new Set();

const transcriptPath = process.env.CLAUDE_TRANSCRIPT_PATH;
if (transcriptPath) {
  try {
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || entry;
        if (msg.role === 'user') {
          const content = Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : (msg.content || '');
          const trimmed = content.trim().slice(0, 300);
          if (trimmed && !trimmed.startsWith('[Tool')) userRequests.push(trimmed);
        }
        if (msg.role === 'assistant') {
          const content = (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ') : (msg.content || '')).toLowerCase();
          if (content.includes('demandplan') || content.includes('demand plan')) pendingMemoryTopics.add('demand-plan');
          if (content.includes('dashboard') || content.includes('pab')) pendingMemoryTopics.add('dashboard');
          if (content.includes('bigquery') || content.includes('schema')) pendingMemoryTopics.add('bigquery');
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
}

const lines = [`**${dateStr} ${timeStr}** | Branch: \`${branch || 'unknown'}\``, ''];
if (allChangedFiles) lines.push('**Files Changed:**', '```', allChangedFiles, '```');
else lines.push('**Files Changed:** (none)');
if (recentCommits) lines.push('', '**Commits:**', '```', recentCommits, '```');
if (userRequests.length > 0) { lines.push('', '**What Was Worked On:**'); userRequests.forEach(r => lines.push(`- ${r.replace(/\n/g, ' ')}`)); }

const sessionContent = lines.join('\n');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.writeFileSync(path.join(SESSIONS_DIR, 'latest.md'), sessionContent, 'utf8');
const datePath = path.join(SESSIONS_DIR, `${dateStr}.md`);
fs.appendFileSync(datePath, (fs.existsSync(datePath) ? '\n\n---\n\n' : '') + sessionContent, 'utf8');

if (pendingMemoryTopics.size > 0) {
  fs.writeFileSync(path.join(SESSIONS_DIR, 'pending-updates.md'),
    ['Topics touched that may need memory updates:', ...[...pendingMemoryTopics].map(t => `- [ ] \`memory/topics/${t}.md\``)].join('\n'), 'utf8');
} else {
  try { fs.unlinkSync(path.join(SESSIONS_DIR, 'pending-updates.md')); } catch {}
}

if (transcriptPath) {
  const updaterScript = path.join(MEMORY_DIR, 'hooks', 'memory-updater.js');
  if (fs.existsSync(updaterScript)) {
    const child = spawn(process.execPath, [updaterScript, transcriptPath, PROJECT_DIR, MEMORY_DIR], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
}

process.stdout.write(JSON.stringify({ decision: 'approve' }));
```

6. **Write `memory/hooks/memory-updater.js`** with exactly this content:

```javascript
#!/usr/bin/env node
// Background AI memory updater — spawned by session-end.js after every session.
// Usage: node memory-updater.js <transcriptPath> <projectDir> <memoryDir>
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
} catch { process.exit(0); }

if (messages.length === 0) process.exit(0);

const conversationLines = [];
for (const entry of messages.slice(-60)) {
  const msg = entry.message || entry;
  if (!msg.role || !['user', 'assistant'].includes(msg.role)) continue;
  const rawContent = msg.content || '';
  let text = typeof rawContent === 'string' ? rawContent
    : Array.isArray(rawContent) ? rawContent.filter(c => c.type === 'text').map(c => c.text || '').join('\n') : '';
  text = text.trim();
  if (!text || text.startsWith('[Tool') || text.startsWith('{"')) continue;
  conversationLines.push(`${msg.role.toUpperCase()}: ${text.slice(0, 600)}`);
}

if (conversationLines.length < 3) process.exit(0);

const topicsDir = path.join(memoryDir, 'topics');
let existingTopics = [];
try { existingTopics = fs.readdirSync(topicsDir).filter(f => f.endsWith('.md')).map(f => `memory/topics/${f}`); } catch {}

const prompt = `You are maintaining persistent memory files for a software project. Your job is to update topic files in memory/topics/ with verified technical facts from this coding session.

EXISTING TOPIC FILES: ${existingTopics.length > 0 ? existingTopics.join(', ') : '(none yet)'}

SESSION CONVERSATION:
${conversationLines.join('\n\n')}

YOUR TASK:
1. Read the conversation above
2. Identify NEW confirmed technical facts: code paths, schema details, bugs fixed, architectural decisions, non-obvious gotchas
3. Update relevant topic file(s) with these facts
4. If a NEW domain was heavily worked on (not covered by existing topics), CREATE memory/topics/{domain}.md

RULES:
- ONLY write facts confirmed in this session — no speculation
- Read existing topic files first to avoid duplication
- Keep each file under 120 lines using concise bullet points
- New file header: # {Domain} — Deep Context\\n*Memory type: PERMANENT | Update when: {condition}*
- Include specific file paths and function names for code facts
- If nothing genuinely new was discovered, make no changes`;

const result = spawnSync('claude', ['-p', '--input-format', 'text', '--allowedTools', 'Read,Write,Edit,Glob', '--model', 'haiku', '--max-budget-usd', '0.10', '--permission-mode', 'acceptEdits', '--no-session-persistence'], {
  input: prompt, cwd: projectDir, timeout: 180000, encoding: 'utf8', windowsHide: true,
});

const logPath = path.join(memoryDir, 'sessions', 'updater-log.md');
const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
const status = result.status === 0 ? 'updated' : `error (exit ${result.status})`;
try { fs.appendFileSync(logPath, `\n## ${ts} — ${status}\n${result.stderr?.slice(0, 200) || ''}\n`, 'utf8'); } catch {}
```

7. **Write `memory/MEMORY.md`** — create a starter file tailored to THIS project. Before writing it, briefly scan the project (check `package.json`, top-level folders, README if present) to understand the tech stack and main domains. Then write a lean MEMORY.md under 100 lines with:
   - Project name and one-line description
   - Tech stack summary (3-5 lines)
   - Interaction style rules (BigQuery MCP first, no speculation, scope = exactly what's asked)
   - Links to topic files (even if they don't exist yet — they'll be created by the updater)
   - Session memory section pointing to sessions/ files
   - Today's date

8. **Update `.claude/settings.local.json`** — merge the hook configuration into the existing file (preserve all existing content). Add these hooks:
   ```json
   "hooks": {
     "SessionStart": [{ "hooks": [{ "type": "command", "command": "node <MEMORY_DIR>/hooks/session-start.js", "timeout": 15 }] }],
     "Stop": [{ "hooks": [{ "type": "command", "command": "node <MEMORY_DIR>/hooks/session-end.js", "timeout": 30 }] }]
   }
   ```
   Replace `<MEMORY_DIR>` with the full absolute path to the memory directory (using forward slashes). If `hooks` already exists in settings.local.json, merge carefully — do not overwrite existing PostToolUse or other hooks.

9. **Test both hooks** by running them directly:
   - `node <memory_dir>/hooks/session-start.js` — should output JSON with `hookSpecificOutput.hookEventName === "SessionStart"`
   - `node <memory_dir>/hooks/session-end.js` — should output `{"decision":"approve"}`
   If either fails, diagnose and fix before completing.

10. **Report what was set up** — show the user:
    - The memory directory path
    - The 3 files created in hooks/
    - Confirmation both hook tests passed
    - That session-end will spawn a background `claude -p haiku` process after each session to auto-update topic files (costs ~$0.02-0.08/session)
    - One line on how it works: "Every session start shows your git state. Every session end captures what was worked on and runs a background AI to update memory files."

## Rules
- Do NOT skip the hook tests in step 9 — broken hooks silently fail
- Do NOT hardcode paths from a previous project into the hook files (all paths are resolved dynamically via `__dirname` and `git`)
- If `.claude/settings.local.json` does not exist yet, create it with just the hooks and an empty permissions object
- If `memory/MEMORY.md` already exists, do NOT overwrite it — the user already has memory set up
- If all 3 hook files already exist, skip creating them and just verify they work
