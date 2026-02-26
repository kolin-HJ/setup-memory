#!/usr/bin/env node
/**
 * SessionStart Hook — Auto-Injected Context
 *
 * Reads git state + synthesized session briefing (or last session log) to give
 * Claude instant awareness of:
 * - What branch/work is in progress
 * - What files are modified
 * - What was worked on in the last session (AI-synthesized briefing when available)
 * - Relevant topic file contents (preloaded inline — no extra Read commands needed)
 * - Any pending memory updates or background jobs still running
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

/**
 * Load relevant topic files inline — preloads context so Claude doesn't need
 * to issue separate Read commands at session start.
 * - Matches topic filenames against modified/diff file names
 * - Falls back to 2 most recently modified topic files
 * - Caps at 3 files max, truncates each to 80 lines
 */
function getRelevantTopicContent(modifiedFiles) {
  try {
    const topicsDir = path.join(MEMORY_DIR, 'topics');
    const topics = fs.readdirSync(topicsDir).filter(f => f.endsWith('.md'));
    if (topics.length === 0) return '';

    const f = modifiedFiles.toLowerCase();
    const relevant = topics.filter(t => {
      const base = t.replace('.md', '');
      return f.includes(base.replace(/-/g, '')) ||
             f.includes(base) ||
             f.includes(base.replace(/-/g, '_'));
    }).slice(0, 3); // max 3 files

    if (relevant.length === 0) {
      // Fall back: load most recently modified topic files
      const withMtimes = topics.map(t => ({
        name: t,
        mtime: (() => { try { return fs.statSync(path.join(topicsDir, t)).mtimeMs; } catch { return 0; } })()
      })).sort((a, b) => b.mtime - a.mtime).slice(0, 2);
      relevant.push(...withMtimes.map(w => w.name));
    }

    const sections = relevant.map(t => {
      const content = (() => { try { return fs.readFileSync(path.join(topicsDir, t), 'utf8').trim(); } catch { return ''; } })();
      if (!content) return '';
      const lines = content.split('\n').slice(0, 80).join('\n');
      return `**memory/topics/${t}:**\n${lines}`;
    }).filter(s => s.includes('\n'));

    return sections.length > 0 ? sections.join('\n\n') : '';
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

// Check if background memory jobs are still running from the last session end
const pendingJobs = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, 'sessions', 'jobs-pending.json'), 'utf8'));
  } catch {
    return null;
  }
})();

const topicContent = getRelevantTopicContent(modifiedFiles + lastDiffFiles);

const parts = [];
if (branch) parts.push(`**Branch:** \`${branch}\``);
if (recentCommits) parts.push(`**Recent Commits (last 7):**\n\`\`\`\n${recentCommits}\n\`\`\``);
if (modifiedFiles) parts.push(`**Uncommitted Changes:**\n\`\`\`\n${modifiedFiles}\n\`\`\``);
else parts.push('**Uncommitted Changes:** (working tree clean)');
if (pendingJobs) {
  const age = Math.round((Date.now() - new Date(pendingJobs.spawnedAt).getTime()) / 60000);
  parts.push(`**⚠ Background memory jobs still running** (started ${age}m ago — topic files may not be up to date yet)`);
}
if (topicContent) parts.push(`**Loaded Topic Context:**\n${topicContent}`);
if (lastSession) parts.push(`${briefingLabel}\n${lastSession}`);
if (pendingUpdates) parts.push(`**⚠ Pending Memory Updates (from last session):**\n${pendingUpdates}`);

const context = `## 🧠 Auto-Injected Session Context\n*Generated automatically from git state and session history.*\n\n${parts.join('\n\n')}`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
}));
