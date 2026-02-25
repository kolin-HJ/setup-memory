# setup-memory — Intelligent Memory for Claude Code

A Claude Code plugin that sets up a self-maintaining AI memory system for any project. Once installed, Claude automatically learns your codebase over time without any manual effort.

## What it does

- **Session start**: Automatically injects your git branch, recent commits, modified files, and an AI-synthesized session briefing as context — Claude knows what you're working on before you type a word
- **Session end**: Captures what was worked on from the session transcript, then:
  - Spawns a background `claude -p haiku` process (two-pass recursive) that reads the transcript and updates topic files
  - Synchronously runs a session synthesizer to pre-compute a briefing for the next session start
  - Runs a periodic memory health check every 10 sessions to audit and consolidate topic files
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
  └─ Hook reads git state + synthesized briefing → rich context injected automatically

Session End
  └─ Hook captures activity → writes session log
       ├─ Spawns background memory updater (2-pass recursive: extract → critique/refine)
       │    └─ Pass 1: Extract new facts into topic files
       │    └─ Pass 2: Review Pass 1 output, fix gaps and errors
       ├─ Runs session synthesizer (generates briefing for next session start)
       └─ Runs memory health check every 10 sessions (recursive audit + consolidation)
```

## What `/setup-memory` does

When you run `/setup-memory` inside Claude Code, it will:

1. Verify you're inside a git repository
2. Find the hook files inside the plugin installation directory
3. Copy all 5 hook files into your project's memory directory
4. Write a starter `MEMORY.md` tailored to your tech stack (skipped if one exists)
5. Update `.claude/settings.local.json` with `SessionStart` and `Stop` hooks
6. Test both hooks and confirm they work before finishing

Re-running `/setup-memory` on an already-set-up project updates the hooks to the latest plugin version.

## Why recursive?

Based on recent research ("Test-time Recursive Thinking", Feb 2026), LLMs produce significantly
better output when reviewing their own work versus one-shot generation. This plugin applies that
finding at three levels:

1. **Memory updates** — Two passes: extract facts, then critique the extraction
2. **Session synthesis** — Pre-computed briefing is more useful than raw logs
3. **Health checks** — Periodic audit+fix cycle keeps topic files accurate over time

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

## Cost

~$0.05–0.15/session (memory updater + session synthesizer, capped at $0.18 total)
