import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, MAX_CONTEXT_CHARS } from '../scripts/lib/config.mjs';
import { buildSessionContext, truncate } from '../scripts/lib/context.mjs';
import { fx, shortPath } from './helpers.mjs';

const START_LINE = 'Task start: run /nauraiz-dev:start-task on the first substantive request (checks who owns the issue, asks before building, routes the process); to push and open a PR: /nauraiz-dev:ship.';

const build = (name, extra = {}) =>
  buildSessionContext({ cwd: fx(name), ...loadConfig(fx(name)), branch: 'main', plan: null, pluginRoot: null, ...extra });

test('unconfigured repo gets the two-line header', () => {
  const t = build('empty');
  assert.match(t, /no project config/);
  assert.match(t, /\/nauraiz-dev:setup/);
  assert.match(t, /Task start: run \/nauraiz-dev:start-task/);
  assert.ok(!/session\.md/.test(t));
  assert.equal(t.split('\n').length, 2);
  assert.equal(t.split('\n')[1], START_LINE);
  assert.match(t.split('\n')[0], /^nauraiz-dev v\d+\.\d+\.\d+ · enforcement=advisory · state=none · no project config: run \/nauraiz-dev:init \(project\) or \/nauraiz-dev:setup \(machine\)$/);
});

test('scaffold repo includes session head and 5 backlog items', () => {
  const t = build('scaffold');
  assert.match(t, /## session\.md/);
  assert.match(t, /## backlog \(top 5\)/);
  assert.equal((t.match(/^- /gm) || []).length, 5);
  assert.match(t, /^- Example backlog item 1$/m);
  assert.ok(!/item 6/.test(t));
  assert.match(t, /line 20 /);
  assert.ok(!/line 21 /.test(t));
});

test('never exceeds the cap', () => {
  const out = truncate('x'.repeat(10000), MAX_CONTEXT_CHARS);
  assert.ok(out.length <= MAX_CONTEXT_CHARS);
  assert.ok(out.endsWith('…[truncated]'));
  assert.equal(truncate('short', MAX_CONTEXT_CHARS), 'short');
});

test('unreadable project config says so instead of "no project config"', () => {
  const head = build('broken', { branch: null }).split('\n')[0];
  assert.match(head, / · config unreadable: .*nauraiz-dev\.json: invalid JSON/);
  assert.doesNotMatch(head, /no project config/);
});

test('a found config with a bad local file reports a config error', () => {
  const head = build('bad-local').split('\n')[0];
  assert.match(head, / · config error: .*nauraiz-dev\.local\.json/);
  assert.doesNotMatch(head, /unreadable|no project config/);
});

test('compact source adds a refresh line right after the triage line', () => {
  const lines = build('scaffold', { source: 'compact' }).split('\n');
  assert.equal(lines[2], 'Context was just compacted: refresh the handoff with /nauraiz-dev:handoff.');
  assert.ok(!/compacted/.test(build('scaffold', { source: 'startup' })));
});

test('plan handoff is included for state none with a plan', () => {
  const plan = { path: path.join(fx('configured'), 'docs', 'plan.md'), handoff: 'Next: wire the header.' };
  const t = build('configured', { plan });
  assert.match(t, /## plan handoff \(docs\/plan\.md\)\nNext: wire the header\./);
  assert.ok(!/## plan handoff/.test(build('configured', { plan: { path: 'x', handoff: null } })));
});

test('mockupRoot is announced', () => {
  const t = buildSessionContext({
    cwd: fx('configured'), found: true, error: null, branch: null, plan: null,
    config: { enforcement: 'guided', state: 'none', mockupRoot: 'design/mockups' },
  });
  assert.match(t, /^Mockup root: design\/mockups$/m);
});

test('scaffold repo without state files skips those sections', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-ctx-'));
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), '{"state":"scaffold"}');
    const t = buildSessionContext({ cwd: dir, ...loadConfig(dir), branch: null, plan: null });
    assert.match(t, /state=scaffold/);
    assert.ok(!/session\.md/.test(t));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('oversized session head is truncated to the cap', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-ctx-'));
  try {
    mkdirSync(path.join(dir, '.claude', 'state'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), '{"state":"scaffold"}');
    writeFileSync(path.join(dir, '.claude', 'state', 'session.md'), ('y'.repeat(2000) + '\n').repeat(20));
    const t = buildSessionContext({ cwd: dir, ...loadConfig(dir), branch: null, plan: null });
    assert.ok(t.length <= MAX_CONTEXT_CHARS);
    assert.ok(t.endsWith('…[truncated]'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local-only config shows mode=local and the gate line with the expanded runner path (forward slashes)', () => {
  const t = build('local-only', { pluginRoot: 'C:\\Users\\dev\\.claude\\plugins\\nauraiz-dev' });
  const lines = t.split('\n');
  assert.match(lines[0], / · mode=local$/);
  assert.equal(lines[1], START_LINE);
  assert.ok(lines.includes('Gate: test (run node "C:/Users/dev/.claude/plugins/nauraiz-dev/scripts/gate/run.mjs" once, from any folder in the project; it prints every exit code, so never append echo $?, pipes or cd; re-run only after you changed code, or once with --plan <path> when a row says no plan for this branch)'));
  assert.doesNotMatch(t, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.ok(t.length <= MAX_CONTEXT_CHARS);
});

test('local-only gate line without a plugin root points at /nauraiz-dev:gate, never a literal ${CLAUDE_PLUGIN_ROOT}', () => {
  const t = build('local-only');
  assert.ok(t.split('\n').includes('Gate: test (run /nauraiz-dev:gate once, from any folder in the project; it prints every exit code, so never append echo $?, pipes or cd; re-run only after you changed code, or once with --plan <path> when a row says no plan for this branch)'));
  assert.doesNotMatch(t, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});

test('local mode with no gate says so; project mode has no mode tag or Gate line', () => {
  const t = buildSessionContext({
    cwd: fx('configured'), found: true, error: null, branch: null, plan: null, mode: 'local',
    config: { enforcement: 'guided', state: 'none', gate: {} },
  });
  assert.match(t, /^Gate: none configured$/m);
  const p = build('configured', { mode: 'project' });
  assert.doesNotMatch(p, /mode=local|^Gate:/m);
});

test('an unparsable local-only file reports config unreadable, not "no project config"', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-ctx-'));
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.local.json'), '{ nope');
    const loaded = loadConfig(dir);
    assert.equal(loaded.found, false);
    assert.equal(loaded.present, false);
    const head = buildSessionContext({ cwd: dir, ...loaded, branch: null, plan: null }).split('\n')[0];
    assert.match(head, / · config unreadable: .*nauraiz-dev\.local\.json/);
    assert.doesNotMatch(head, /no project config/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('superpowers warning appears only when it is not installed and enabled', () => {
  const warning = 'superpowers is not installed or not enabled: run /nauraiz-dev:setup';
  const has = (superpowers) => build('configured', { superpowers }).split('\n').includes(warning);
  assert.equal(has({ installed: false, enabled: false }), true);
  assert.equal(has({ installed: true, enabled: false }), true);
  assert.equal(has({ installed: true, enabled: true }), false);
  assert.equal(has(undefined), false);
});

test('a mockupRoot link that leaves the folder is flagged with the real path', (t) => {
  const outside = mkdtempSync(path.join(os.tmpdir(), 'nd-out-'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-ctx-'));
  try {
    try {
      symlinkSync(outside, path.join(dir, 'mockups'), 'junction');
    } catch {
      t.skip('cannot create a link here');
      return;
    }
    const out = buildSessionContext({
      cwd: dir, found: true, error: null, branch: null, plan: null,
      config: { enforcement: 'guided', state: 'none', mockupRoot: 'mockups' },
    });
    const real = realpathSync.native(outside);
    assert.ok(out.split('\n').includes(`Mockup root resolves outside this folder (${real}); project hooks may deny it: copy it instead of linking.`));
    assert.match(out, /^Mockup root: mockups$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a mockupRoot inside the folder gets no warning; a missing one is reported', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-ctx-'));
  try {
    mkdirSync(path.join(dir, 'mockups'));
    const withRoot = (mockupRoot) => buildSessionContext({
      cwd: dir, found: true, error: null, branch: null, plan: null,
      config: { enforcement: 'guided', state: 'none', mockupRoot },
    });
    assert.doesNotMatch(withRoot('mockups'), /resolves outside|not found/);
    assert.match(withRoot('gone'), /^Mockup root not found: gone$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a mockupRoot inside the folder is not flagged when cwd is an 8.3 short path and the root a long one', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-ctx-shortname-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'mockups'));
  const short = shortPath(dir);
  if (!short) { t.skip('no 8.3 short name here (not win32, or 8.3 names disabled)'); return; }
  const out = buildSessionContext({
    cwd: short, found: true, error: null, branch: null, plan: null,
    config: { enforcement: 'guided', state: 'none', mockupRoot: path.join(realpathSync.native(dir), 'mockups') },
  });
  assert.doesNotMatch(out, /resolves outside|not found/);
});
