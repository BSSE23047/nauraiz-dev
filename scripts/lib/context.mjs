import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CONTEXT_CHARS } from './config.mjs';
import { realPath } from './paths.mjs';

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
 * A warning line when the configured mockup root is missing or resolves (through a link) outside `cwd`,
 * else null. Project hooks may deny a path outside the folder, so a link out of it is worth saying.
 */
function mockupRootWarning(cwd, mockupRoot) {
  // native realpath on both sides, so an 8.3 short name on one side is not read as "outside"
  const real = realPath(path.resolve(cwd, mockupRoot));
  if (real === null) return `Mockup root not found: ${mockupRoot}`;
  const realCwd = realPath(cwd);
  if (realCwd === null) return null; // an unresolvable cwd gives nothing to compare against
  const rel = path.relative(realCwd, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return `Mockup root resolves outside this folder (${real}); project hooks may deny it: copy it instead of linking.`;
  }
  return null;
}

/**
 * The context injected at session start: a header, the start-task line (plus the local-mode gate and any setup warnings) and, depending on the project's
 * state, the head of session.md, the top backlog headings or the active plan's handoff.
 * `source` is the SessionStart payload source (startup|resume|clear|compact|fork). `pluginRoot` (default
 * CLAUDE_PLUGIN_ROOT) is spelled out in the local-mode gate line, since hook output is not variable-expanded.
 */
export function buildSessionContext({ cwd, config, found, error, branch, plan, source, mode, superpowers, pluginRoot = process.env.CLAUDE_PLUGIN_ROOT }) {
  let header = `nauraiz-dev v${VERSION} · enforcement=${config.enforcement} · state=${config.state}`;
  if (mode === 'local') header += ' · mode=local';
  if (!found && error) header += ` · config unreadable: ${error}`; // a file exists but did not parse: init is not the fix
  else {
    if (!found) header += ' · no project config: run /nauraiz-dev:init (project) or /nauraiz-dev:setup (machine)';
    if (error) header += ` · config error: ${error}`;
  }

  const out = [
    header,
    'Task start: run /nauraiz-dev:start-task on the first substantive request (checks who owns the issue, asks before building, routes the process); to push and open a PR: /nauraiz-dev:ship.',
  ];
  if (mode === 'local') {
    const gate = Object.keys(config.gate ?? {});
    const run = pluginRoot
      ? `node "${pluginRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/scripts/gate/run.mjs"`
      : '/nauraiz-dev:gate';
    out.push(gate.length
      ? `Gate: ${gate.join(', ')} (run ${run} once, from any folder in the project; it prints every exit code, so never append echo $?, pipes or cd; re-run only after you changed code, or once with --plan <path> when a row says no plan for this branch)`
      : 'Gate: none configured');
  }
  if (superpowers && !(superpowers.installed && superpowers.enabled)) {
    out.push('superpowers is not installed or not enabled: run /nauraiz-dev:setup');
  }
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

  if (config.mockupRoot) {
    out.push(`Mockup root: ${config.mockupRoot}`);
    const warning = mockupRootWarning(cwd, config.mockupRoot);
    if (warning) out.push(warning);
  }

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
