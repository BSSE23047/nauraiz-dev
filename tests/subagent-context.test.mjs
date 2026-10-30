import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, MAX_CONTEXT_CHARS } from '../scripts/lib/config.mjs';
import { buildSubagentContext } from '../scripts/lib/context.mjs';
import { fx } from './helpers.mjs';

const build = (name, extra = {}) => buildSubagentContext({ cwd: fx(name), ...loadConfig(fx(name)), ...extra });

test('not found -> empty string', () => {
  assert.equal(build('empty'), '');
});

test('short rule is included whole, README index skipped', () => {
  const t = build('scaffold');
  assert.match(t, /^# Project rules \(nauraiz-dev\)/);
  assert.match(t, /Tests must use injected fakes\. Never point a test at a live database or service\./);
  assert.ok(!/Rules index/.test(t));
});

test('long rule is summarised with heading, first paragraph and a path pointer', () => {
  const t = build('scaffold');
  assert.match(t, /# Long example rule/);
  assert.match(t, /This first paragraph states the rule in two lines\.\nIt continues on a second line\./);
  assert.match(t, /\(see \.claude\/rules\/long\.md\)/);
  assert.ok(!/DETAIL_MARKER/.test(t));
  assert.ok(!/## Details/.test(t));
});

test('rules are sorted by name', () => {
  const t = build('scaffold');
  assert.ok(t.indexOf('Long example rule') < t.indexOf('No live data in tests'));
});

test('gate command names are listed', () => {
  assert.match(build('scaffold'), /^Gate commands: build, test$/m);
});

test('no gate line when no gate commands are configured', () => {
  const { config } = loadConfig(fx('scaffold'));
  const t = buildSubagentContext({ cwd: fx('scaffold'), config: { ...config, gate: {} }, found: true });
  assert.ok(!/Gate commands/.test(t));
});

test('output respects the cap', () => {
  const { config } = loadConfig(fx('scaffold'));
  const t = buildSubagentContext({ cwd: fx('scaffold'), config: { ...config, gate: Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`cmd${i}`, 'x'])) }, found: true });
  assert.ok(t.length <= MAX_CONTEXT_CHARS);
  assert.ok(t.endsWith('…[truncated]'));
});
