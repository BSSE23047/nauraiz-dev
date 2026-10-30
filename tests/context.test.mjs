import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, MAX_CONTEXT_CHARS } from '../scripts/lib/config.mjs';
import { buildSessionContext, truncate } from '../scripts/lib/context.mjs';
import { fx } from './helpers.mjs';

const build = (name, extra = {}) =>
  buildSessionContext({ cwd: fx(name), ...loadConfig(fx(name)), branch: 'main', plan: null, ...extra });

test('unconfigured repo gets the two-line header', () => {
  const t = build('empty');
  assert.match(t, /no project config/);
  assert.match(t, /\/nauraiz-dev:setup/);
  assert.match(t, /Triage/);
  assert.ok(!/session\.md/.test(t));
  assert.equal(t.split('\n').length, 2);
  assert.match(t.split('\n')[0], /^nauraiz-dev v0\.1\.0 · enforcement=advisory · state=none · no project config: run \/nauraiz-dev:init \(project\) or \/nauraiz-dev:setup \(machine\)$/);
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
