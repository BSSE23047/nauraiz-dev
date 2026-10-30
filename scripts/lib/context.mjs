import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CONTEXT_CHARS } from './config.mjs';

const SUFFIX = '…[truncated]';
const SESSION_LINES = 20;
const BACKLOG_ITEMS = 5;
const RULE_FULL_MAX = 1500;

const VERSION = (() => {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude-plugin', 'plugin.json');
    return JSON.parse(readFileSync(file, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** Cut `text` to at most `max` characters, ending in a visible marker when anything was dropped. */
export function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - SUFFIX.length)) + SUFFIX;
}

/** Lines of a state file, or null when it is missing or unreadable. */
function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * The context injected at session start: a header, the triage line and, depending on the project's
 * state, the head of session.md, the top backlog headings or the active plan's handoff.
 * `source` is the SessionStart payload source (startup|resume|clear|compact|fork).
 */
export function buildSessionContext({ cwd, config, found, present, error, branch, plan, source }) {
  let header = `nauraiz-dev v${VERSION} · enforcement=${config.enforcement} · state=${config.state}`;
  if (!found && present) header += ` · config unreadable: ${error}`; // the file exists: init is not the fix
  else {
    if (!found) header += ' · no project config: run /nauraiz-dev:init (project) or /nauraiz-dev:setup (machine)';
    if (error) header += ` · config error: ${error}`;
  }

  const out = [
    header,
    'Triage the first substantive request: small → do it and verify; normal/large → plan before any edit.',
  ];
  if (source === 'compact') out.push('Context was just compacted: refresh the handoff with /nauraiz-dev:handoff.');

  if (found && config.state === 'scaffold') {
    const stateDir = path.join(cwd, '.claude', 'state');
    const session = readLines(path.join(stateDir, 'session.md'));
    if (session) out.push('## session.md', ...session.slice(0, SESSION_LINES));
    const backlog = readLines(path.join(stateDir, 'backlog.md'));
    if (backlog) {
      const items = backlog
        .map((line) => /^## (.*?)\s*$/.exec(line))
        .filter(Boolean)
        .slice(0, BACKLOG_ITEMS)
        .map((m) => `- ${m[1]}`);
      out.push('## backlog (top 5)', ...items);
    }
  }

  if (found && config.state === 'none' && plan?.handoff) {
    const rel = plan.path ? toPosix(path.relative(cwd, plan.path)) : '';
    out.push(`## plan handoff (${rel || plan.path})`, plan.handoff);
  }

  if (config.mockupRoot) out.push(`Mockup root: ${config.mockupRoot}`);

  return truncate(out.join('\n'), MAX_CONTEXT_CHARS);
}

/** First heading line plus the first paragraph after it (to the next blank line or heading). */
function summariseRule(text) {
  const lines = text.split(/\r?\n/);
  const isHeading = (l) => /^#{1,6}\s/.test(l);
  const h = lines.findIndex(isHeading);
  const para = [];
  for (let i = h + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) break;
    if (lines[i].trim() === '') {
      if (para.length) break;
      continue;
    }
    para.push(lines[i]);
  }
  return [...(h >= 0 ? [lines[h]] : []), ...para].join('\n');
}

/**
 * The context injected into every spawned subagent (subagents do not inherit CLAUDE.md): the project's
 * .claude/rules/*.md (README.md skipped; short rules whole, long ones as heading + first paragraph + a
 * pointer) and the names of the configured gate commands. Empty when the project has no config.
 */
export function buildSubagentContext({ cwd, config, found }) {
  if (!found) return '';
  const rulesDir = path.join(cwd, '.claude', 'rules');
  let names = [];
  try {
    names = readdirSync(rulesDir).filter((n) => n.endsWith('.md') && n !== 'README.md').sort();
  } catch {
    names = [];
  }

  const out = ['# Project rules (nauraiz-dev)'];
  for (const name of names) {
    let text;
    try {
      text = readFileSync(path.join(rulesDir, name), 'utf8').trim();
    } catch {
      continue;
    }
    if (!text) continue;
    out.push(text.length <= RULE_FULL_MAX ? text : `${summariseRule(text)}\n(see .claude/rules/${name})`);
  }

  const gate = Object.keys(config.gate ?? {});
  if (gate.length) out.push(`Gate commands: ${gate.join(', ')}`);

  return truncate(out.join('\n\n'), MAX_CONTEXT_CHARS);
}
