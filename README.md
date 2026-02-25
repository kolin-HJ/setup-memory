# setup-memory — Intelligent Memory for Claude Code

A Claude Code plugin that sets up a self-maintaining AI memory system for any project. Once installed, Claude automatically learns your codebase over time without any manual effort.

## What it does

- **Session start**: Automatically injects your git branch, recent commits, modified files, and last session summary as context — Claude knows what you're working on before you type a word
- **Session end**: Captures what was worked on from the session transcript, then spawns a background `claude -p haiku` process that reads the transcript and updates topic files with new discoveries
- **Over time**: Topic files in `memory/topics/` accumulate verified facts about your codebase — schema details, code paths, bugs fixed, patterns discovered — making Claude progressively smarter about your project

## Quick Start

**Step 1 — Install the plugin** *(run in your terminal, one-time global setup)*

```bash
claude plugin marketplace add kolin-hj/setup-memory
```

```bash
claude plugin install setup-memory
```

**Step 2 — Set up memory for a project** *(run inside Claude Code, once per project)*

```
/setup-memory
```

That's it. Claude will detect your project, create all hook files, write a starter `MEMORY.md`, and verify everything is working.

## Requirements

- Claude Code with an active subscription (used by the background haiku updater)
- Node.js (already required by Claude Code)
- A git repository (`/setup-memory` must be run from inside a git repo)

## How it works

```
Session Start
  └─ Hook reads git state + last session → injected as context automatically

Session End
  └─ Hook captures activity → spawns background AI (haiku, ~$0.02-0.08/session)
       └─ Reads full transcript → updates memory/topics/*.md with new discoveries
```

## What `/setup-memory` does

When you run `/setup-memory` inside Claude Code, it will:

1. Verify you're inside a git repository
2. Create all hook files in your project's memory directory
3. Write a starter `MEMORY.md` tailored to your tech stack
4. Update `.claude/settings.local.json` with `SessionStart` and `Stop` hooks
5. Test both hooks and confirm they work before finishing

## Files created

```
memory/
  MEMORY.md                  ← Auto-loaded index (< 150 lines)
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

## Cost

The background memory updater uses `claude -p haiku`, capped at `$0.10` per session. Typical cost is **$0.02–0.08 per session**.
