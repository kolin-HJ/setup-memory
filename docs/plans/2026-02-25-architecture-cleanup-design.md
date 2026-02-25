# Design: Architecture Cleanup + Reliability Improvements
*Date: 2026-02-25*

## Problem

The repo has two structural problems and several minor bugs introduced during the v2 PR merge:

1. **Duplicate source of truth**: Hook code exists in both `plugin/hooks/*.js` and embedded inline inside `commands/setup-memory.md`. These will drift out of sync. The `plugin/hooks/` files are never what actually runs — the command copies inline text into each project.

2. **Runtime bug**: `session-end.js` runs the session synthesizer and health checker with `spawnSync` (blocking). The Stop hook timeout in `settings.local.json` is 30 seconds. The synthesizer has a 60s timeout and health checker has a 120s timeout — they get killed before finishing.

---

## Design

### 1. Single source of truth — hooks at repo root

Rename `plugin/hooks/` → `hooks/`. The repo root is the plugin; calling it `plugin/hooks/` is redundant and confusing.

`commands/setup-memory.md` no longer embeds hook code. Instead it instructs Claude to:
1. Find the installed hooks directory by globbing for `session-start.js` under `~/.claude/plugins/` in a path containing `setup-memory`
2. Read each hook file from that directory
3. Write it to `<memory-dir>/hooks/`

Re-running `/setup-memory` on an existing project becomes a valid "update to latest hooks" operation.

### 2. All background jobs detached

`session-end.js` spawns all three jobs (memory-updater, session-synthesizer, memory-health) as detached fire-and-forget processes using `spawn` + `unref()`. The hook returns `{"decision":"approve"}` in under a second. Stop hook timeout stays at 30s.

Rationale: none of these jobs need to finish before the session ends — they just need to finish before the next session starts. There is always a gap. The memory-updater has worked this way from the start with no issues.

`session-end.js` writes a header line to `updater-log.md` when spawning, so the log captures all three jobs in one place.

### 3. Bug fixes

- **`hooks/session-start.js`**: `domainHints` → `topicHints` (variable defined as `topicHints` on line 129, referenced incorrectly in one branch after merge conflict resolution)
- **`MEMORY.md` template**: Remove "Current Date" field — set at install time and immediately stale; session-start hook already injects live git state each session
- **`commands/setup-memory.md` description**: Update to reflect synthesized briefings and three-job background system (currently still says "last session summary")

### 4. Metadata updates

- **`.claude-plugin/plugin.json`**: Bump version `1.1.0` → `2.0.0`, update description to reflect recursive two-pass updates, session synthesizer, and health checks
- **`README.md`**: Fix `## Files created` to show all 5 hooks and `health-state.json`; fix "What `/setup-memory` does" step count

---

## File Change Summary

| File | Change |
|------|--------|
| `plugin/hooks/` → `hooks/` | Rename directory |
| `hooks/session-end.js` | Synthesizer + health checker become detached `spawn`+`unref()` |
| `hooks/session-start.js` | Fix `domainHints` → `topicHints` |
| `commands/setup-memory.md` | Remove ~400 lines embedded JS; add glob-and-copy steps; update description |
| `README.md` | Fix Files Created (5 hooks + health-state.json); fix step descriptions |
| `.claude-plugin/plugin.json` | Bump to 2.0.0, update description |

---

## Success Criteria

- `hooks/` directory exists at repo root; `plugin/` directory is gone
- `commands/setup-memory.md` contains zero embedded JS code blocks
- Running `/setup-memory` on a fresh project produces working hooks by copying from the plugin install dir
- Re-running `/setup-memory` on an existing project updates hooks to latest version
- Session ends in under 1 second (Stop hook returns immediately)
- All three background jobs appear in `updater-log.md` after a session
- No conflict markers or stale variable names in any source file
