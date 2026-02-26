#!/usr/bin/env node
/**
 * Session Synthesizer — Pre-Computed Briefing for Next Session
 *
 * Runs asynchronously at session END (triggered by session-end.js).
 * Generates a concise AI-synthesized briefing so session START gets rich
 * context instead of raw git state.
 *
 * Reads:
 *   - sessions/latest.md (what was worked on)
 *   - Last 10 transcript user messages (what was actually being built/fixed)
 *   - 3 most recently modified topic files (accumulated project knowledge)
 *
 * Writes: sessions/briefing.md
 *
 * Uses `claude -p haiku` (~5-10s, fast). Runs detached as background job.
 *
 * PORTABLE: All paths passed as arguments — no hardcoded values.
 *
 * Usage: node session-synthesizer.js <transcriptPath> <projectDir> <memoryDir>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [,, transcriptPath, projectDir, memoryDir] = process.argv;

const sessionsDir = path.join(memoryDir, 'sessions');
const briefingPath = path.join(sessionsDir, 'briefing.md');

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

// Read latest session summary
const latestSession = readFile(path.join(sessionsDir, 'latest.md'));
if (!latestSession) process.exit(0);

// Extract last 10 user messages from transcript (first 200 chars each)
let userMessages = [];
if (transcriptPath && fs.existsSync(transcriptPath)) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || entry;
        if (msg.role !== 'user') continue;
        const rawContent = msg.content || '';
        let text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.filter(c => c.type === 'text').map(c => c.text || '').join(' ')
            : '';
        text = text.trim().slice(0, 200);
        if (text && !text.startsWith('[Tool') && !text.startsWith('{"')) {
          userMessages.push(text);
        }
      } catch {}
    }
    userMessages = userMessages.slice(-10);
  } catch {}
}

// Load the 3 most recently modified topic files for richer synthesis context
function getRecentTopicContent(memoryDir) {
  try {
    const topicsDir = path.join(memoryDir, 'topics');
    const files = fs.readdirSync(topicsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        name: f,
        mtime: (() => { try { return fs.statSync(path.join(topicsDir, f)).mtimeMs; } catch { return 0; } })()
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3);

    return files.map(({ name }) => {
      const content = (() => { try { return fs.readFileSync(path.join(topicsDir, name), 'utf8').trim(); } catch { return ''; } })();
      return content ? `### ${name}\n${content.split('\n').slice(0, 40).join('\n')}` : '';
    }).filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}

const topicContext = getRecentTopicContent(memoryDir);

const prompt = `You are generating a session briefing for the NEXT coding session on this project.

SESSION ACTIVITY:
${latestSession}

RECENT USER REQUESTS (what was actually being built/fixed):
${userMessages.length > 0 ? userMessages.map((m, i) => `${i + 1}. ${m.replace(/\n/g, ' ')}`).join('\n') : '(not available)'}

PROJECT ACCUMULATED KNOWLEDGE (recent topics):
${topicContext || '(no topic files yet)'}

TASK: Write a concise briefing (max 10 bullet points) for the developer opening this project tomorrow.
Focus on:
- Current state: what was completed, what's in progress, what's broken
- Open questions or decisions that need to be made
- Gotchas and non-obvious things discovered this session
- What to do FIRST when returning to this work
- Any bugs introduced or not yet fully fixed

Format as tight bullet points. Be specific — include function names, file paths, exact error messages where relevant. Skip anything obvious.`;

const result = spawnSync('claude', [
  '-p',
  '--input-format', 'text',
  '--output-format', 'text',
  '--model', 'haiku',
  '--max-budget-usd', '0.03',
  '--no-session-persistence',
], {
  input: prompt,
  cwd: projectDir,
  timeout: 60000,
  encoding: 'utf8',
  windowsHide: true,
});

if (result.status === 0 && result.stdout && result.stdout.trim()) {
  const generated = result.stdout.trim();
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const briefingContent = `*Synthesized: ${timestamp} — confidence: fresh*\n\n${generated}\n`;
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(briefingPath, briefingContent, 'utf8');
  } catch {}
}
