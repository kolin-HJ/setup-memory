# setup-memory — Intelligent Memory for Claude Code

Claude forgets everything when you close a session. Every time you reopen a project you spend the first few minutes re-explaining your codebase, recapping what you were working on, and re-establishing context. This plugin fixes that.

setup-memory gives Claude a persistent memory that grows smarter with every session — automatically, in the background, with no manual work.

## What problem this solves

The cold-start problem: every Claude Code session starts with zero context. You lose:

- What was in-progress last session
- Architectural decisions you explained last week
- Bugs you fixed and why they broke
- Commands that actually work in this project

After one `/setup-memory` command, each session start automatically injects your git state, a synthesized briefing of last session, and preloaded topic files with accumulated project knowledge — all before you type a word.

## Quick Start

**Step 1 — Install the plugin** *(one-time global setup, run in your terminal)*

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

That's it. Claude detects your project, copies hook files, writes a starter `MEMORY.md`, and verifies everything works.

## Directory structure created

```
memory/
├── README.md                  ← Memory structure guide (this file, for future sessions)
├── MEMORY.md                  ← Auto-loaded project index (< 150 lines)
├── hooks/
│   ├── session-start.js       ← SessionStart hook: injects git state + briefing
│   ├── session-end.js         ← Stop hook: captures activity, spawns background jobs
│   ├── memory-updater.js      ← Background AI updater (3-pass recursive)
│   ├── session-synthesizer.js ← Generates briefing for next cold-start
│   └── memory-health.js       ← Periodic topic file audit + cleanup (every 10 sessions)
├── topics/                    ← Domain knowledge (auto-created per session)
│   ├── architecture.md        ← System design decisions
│   ├── decisions.md           ← Why things were built certain ways
│   ├── commands.md            ← Working commands and scripts
│   ├── lessons.md             ← Failed approaches to avoid
│   └── <domain>.md            ← Auto-created for any domain heavily worked on
└── sessions/
    ├── latest.md              ← Last session activity summary
    ├── briefing.md            ← AI-synthesized briefing for next session start
    ├── YYYY-MM-DD.md          ← Historical session logs
    ├── updater-log.md         ← Background job run history
    ├── health-state.json      ← Health check session counter
    └── jobs-pending.json      ← Signals background jobs are still running
```

## Hook files

| File | Event | What it does |
|------|-------|--------------|
| session-start.js | SessionStart | Reads git state + briefing + topic files → injects rich context automatically |
| session-end.js | Stop | Captures session activity, writes session log, spawns 3 background jobs |
| memory-updater.js | (background) | 3-pass recursive: extract facts → self-critique → capture decisions + commands |
| session-synthesizer.js | (background) | Reads session + topic files → generates synthesized briefing for next cold-start |
| memory-health.js | (background) | Every 10 sessions: audit all topic files → fix contradictions/redundancy |

## How the recursive improvement works

Based on "Test-time Recursive Thinking" research (Feb 2026) — LLMs produce significantly better output when reviewing their own work.

This plugin applies recursive thinking at three levels:

**1. Memory updates (memory-updater.js) — 3 passes:**

```
Pass 1: Extract new facts from session transcript → update topic files
        Also: capture lessons learned (failed approaches + gotchas)
Pass 2: Review Pass 1 output → fix gaps, remove speculation, resolve contradictions
Pass 3: Extract architectural decisions → decisions.md
        Extract confirmed working commands → commands.md
```

**2. Session synthesis (session-synthesizer.js):**

```
Reads: session log + last 10 user messages + 3 most recent topic files
→ Generates: concise briefing with current state, open questions, what to do first
```

Pre-computing the briefing at session END means session START has instant rich context instead of raw logs.

**3. Health checks (memory-health.js) — 2 passes every 10 sessions:**

```
Pass 1: Audit all topic files — find outdated info, contradictions, redundancy
Pass 2: Apply fixes — uses full file contents for precise edits
```

## Session flow

```
Session Start
  └─ session-start.js runs
       ├─ Reads: git branch, recent commits, uncommitted changes
       ├─ Checks: jobs-pending.json (warns if last session's jobs still running)
       ├─ Loads: relevant topic files inline (up to 3, matched by filename)
       └─ Injects: sessions/briefing.md (or sessions/latest.md fallback)

Session End
  └─ session-end.js runs
       ├─ Writes: sessions/latest.md, sessions/YYYY-MM-DD.md
       ├─ Writes: sessions/jobs-pending.json (cleared when updater finishes)
       └─ Spawns (detached, fire-and-forget):
            ├─ memory-updater.js   → 3-pass topic file update (~$0.18 budget)
            ├─ session-synthesizer.js → generates briefing (~$0.03 budget)
            └─ memory-health.js    → runs every 10 sessions (~$0.13 budget)
```

## Cost

| Job | Frequency | Budget cap |
|-----|-----------|------------|
| Memory updater (3 passes) | Every session | $0.18 |
| Session synthesizer | Every session | $0.03 |
| Memory health check | Every 10 sessions | $0.13 |

Typical per-session cost: ~$0.05–0.15 (haiku model, scales with session length)

## Requirements

- Claude Code with an active subscription
- Node.js (already required by Claude Code)
- A git repository (required for context injection)

## Troubleshooting

**Memory not updating after sessions?** Check `memory/sessions/updater-log.md` — this logs every background job run with timing and errors.

**Background jobs failing to start?** Check that `claude` is in PATH: run `which claude` in your terminal. If not found, Claude Code may not be in your shell PATH. Add it: `export PATH="$PATH:/path/to/claude"`.

**"Background memory jobs still running" warning at session start?** This means the previous session's memory updater hasn't finished yet. Topic files may reflect the session before last. Normal for long sessions — usually resolves in 1–2 minutes.

**Context too large / briefing too long?** Delete or trim old topic files in `memory/topics/`. The health check runs automatically every 10 sessions, but you can manually remove stale files anytime.

**Hooks stopped working after update?** Re-run `/setup-memory` in Claude Code — it copies the latest hook files from the plugin installation to your project memory directory.

**Hook file not found errors?** The hooks directory is inside your project's Claude memory dir (not the plugin dir). Check the path in `.claude/settings.local.json` and make sure the `memory/hooks/` directory exists.
