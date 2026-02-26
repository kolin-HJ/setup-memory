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

Use the Glob tool to find `session-start.js` inside the Claude plugins directory. Search for this file under the user's `.claude/plugins/` directory — it will be in a path containing `setup-memory` and `hooks`.

The directory containing `session-start.js` is the plugin hooks directory. Call it `<plugin-hooks-dir>`.

If the Glob tool finds no results, try searching more broadly: look for any `session-start.js` under `~/.claude/plugins/` on Mac/Linux or `C:\Users\<username>\.claude\plugins\` on Windows.

### Step 5 — Copy hook files to the project memory directory

Read each of these 5 files from `<plugin-hooks-dir>/` and write it to `<memory-dir>/hooks/`:

- `session-start.js`
- `session-end.js`
- `memory-updater.js`
- `session-synthesizer.js`
- `memory-health.js`

Copy the file contents exactly — do not modify them.

If hook files already exist in `<memory-dir>/hooks/`, overwrite them (this is how re-running /setup-memory updates to the latest plugin version).

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

### Step 8 — Create `<memory-dir>/README.md`

**Only run this step if `README.md` does NOT already exist in the memory directory.**

Create `<memory-dir>/README.md` with the following content (this helps future Claude sessions understand the memory structure immediately):

```markdown
# Project Memory

This directory maintains persistent AI memory for this project.

## Structure
- `topics/` — Deep technical context by domain (auto-updated after each session)
- `sessions/` — Session logs, briefings, and update logs
  - `latest.md` — Most recent session activity
  - `briefing.md` — AI-synthesized context for next session start
  - `updater-log.md` — Background job logs
  - `decisions.md` — NOT HERE (see topics/decisions.md)

## How to use
- At session start: context auto-injected. Topic files loaded automatically.
- At session end: topic files updated in background (~30-60s after session ends)
- Run `/setup-memory` to reinitialize if hooks break

## Topic files
Auto-created based on what gets worked on. Common ones:
- `topics/architecture.md` — System design decisions
- `topics/decisions.md` — Why things were built certain ways
- `topics/commands.md` — Working commands and scripts
- `topics/lessons.md` — Failed approaches to avoid
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
5. **"After each session ends, three background processes run: a two-pass memory updater, a session synthesizer (generates a briefing for your next cold-start), and a periodic health checker every 10 sessions. Check `memory/sessions/updater-log.md` to see them working."**
6. Cost: ~$0.05–0.15 per session (memory updater + session synthesizer, capped at $0.18 total)

---

## Rules
- Do NOT skip Step 9 — hooks that fail produce no error; the system silently stops working
- Do NOT use `~` in hook command paths in settings.local.json — always expand to full absolute path
- Do NOT create `MEMORY.md` if it already exists — skip Step 6
- Do NOT create `README.md` if it already exists in the memory directory — skip Step 8
- Do NOT remove any existing keys from `settings.local.json` — only add new hook entries
- If all 5 hook files already exist in `<memory-dir>/hooks/`, still copy them (Step 5) — this updates to latest plugin version
