# setup-memory — Intelligent Memory for Claude Code

A Claude Code plugin that sets up a self-maintaining AI memory system for any project. Once installed, Claude automatically learns your codebase over time without any manual effort.

## What it does

- **Session start**: Automatically injects your git branch, recent commits, modified files, and last session summary as context — Claude knows what you're working on before you type a word
- **Session end**: Captures what was worked on from the session transcript, then spawns a background `claude -p haiku` process that reads the transcript and updates topic files with new discoveries
- **Over time**: Topic files in `memory/topics/` accumulate verified facts about your codebase — schema details, code paths, bugs fixed, patterns discovered — making Claude progressively smarter about your project

## Install

```bash
claude plugin install github:YOUR_USERNAME/setup-memory
```

## Usage

Run once per project from inside a git repository:

```
/setup-memory
```

Claude will:
1. Detect your project structure
2. Create all hook files
3. Write a starter `MEMORY.md` tailored to your tech stack
4. Update `.claude/settings.local.json` with SessionStart and Stop hooks
5. Test both hooks before finishing

## How it works

```
Session Start
  └─ Hook reads git state + last session → injected as context automatically

Session End
  └─ Hook captures activity → spawns background AI (haiku, ~$0.02-0.08/session)
       └─ Reads full transcript → updates memory/topics/*.md with new discoveries
```

## Files created

```
memory/
  MEMORY.md                  ← Auto-loaded index (< 100 lines)
  hooks/
    session-start.js         ← SessionStart hook
    session-end.js           ← Stop hook
    memory-updater.js        ← Background AI updater
  topics/                    ← Domain knowledge (auto-created per session)
  sessions/
    latest.md                ← Last session summary
    YYYY-MM-DD.md            ← Historical logs
    updater-log.md           ← Background AI run history
```

## Requirements

- Claude Code with an active subscription (used by the background haiku updater)
- Node.js (already required by Claude Code)
- A git repository
