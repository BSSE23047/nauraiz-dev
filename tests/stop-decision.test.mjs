import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compact, decideStop } from '../scripts/lib/stop-decision.mjs';

const GATE = { build: 'npm run build' };
const cfg = (enforcement, extra = {}) => ({ enforcement, state: 'none', gate: GATE, ...extra });
const edit = (ts) => ({ ts, role: 'assistant', toolUses: [{ name: 'Edit', input: {} }], usage: null, msgId: null });
const bash = (ts, command) => ({ ts, role: 'assistant', toolUses: [{ name: 'Bash', input: { command } }], usage: null, msgId: null });
const usage = (ts, i, o, cr, cw) => ({ ts, role: 'assistant', toolUses: [], usage: { input: i, output: o, cacheRead: cr, cacheWrite: cw }, msgId: null });
const base = { found: true, sessionMdMtime: null, warned: [] };

test('cost line names every total, main thread only', () => {
  const r = decideStop({ ...base, config: cfg('advisory'), entries: [usage(1, 82, 15363, 3157462, 41000)] });
  assert.equal(r.costLine, 'nauraiz-dev · tokens this session (main thread): output 15.4k, cache read 3.16M, cache write 41k, input 82');
});

test('compact numbers', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(999), '999');
  assert.equal(compact(1000), '1k');
  assert.equal(compact(15363), '15.4k');
  assert.equal(compact(3157462), '3.16M');
  assert.equal(compact(2000000), '2M');
});

test('advisory with edits and no gate run: cost only', () => {
  const r = decideStop({ ...base, found: false, config: cfg('advisory'), entries: [edit(100)] });
  assert.equal(r.warning, null);
  assert.equal(r.block, false);
  assert.match(r.costLine, /^nauraiz-dev · tokens/);
});

test('guided first time: warns once about the gate', () => {
  const r = decideStop({ ...base, config: cfg('guided'), entries: [edit(100)] });
  assert.equal(r.warning, 'gate not run after last edit');
  assert.equal(r.block, false);
});

test('guided second time: no warning', () => {
  const r = decideStop({ ...base, warned: ['gate not run after last edit'], config: cfg('guided'), entries: [edit(100)] });
  assert.equal(r.warning, null);
  assert.equal(r.block, false);
});

test('gate run after the last edit: no problem', () => {
  const entries = [edit(100), bash(200, 'npm run build')];
  const r = decideStop({ ...base, config: cfg('strict'), entries });
  assert.equal(r.warning, null);
  assert.equal(r.block, false);
});

test('gate run before the last edit still counts as not run', () => {
  const entries = [bash(50, 'npm run build'), edit(100)];
  const r = decideStop({ ...base, config: cfg('guided'), entries });
  assert.equal(r.warning, 'gate not run after last edit');
});

test('strict: blocks, and keeps blocking after a warning', () => {
  const first = decideStop({ ...base, config: cfg('strict'), entries: [edit(100)] });
  assert.equal(first.block, true);
  assert.equal(first.warning, 'gate not run after last edit');
  const again = decideStop({ ...base, warned: ['gate not run after last edit'], config: cfg('strict'), entries: [edit(100)] });
  assert.equal(again.block, true);
  assert.equal(again.warning, null);
});

test('no edits: nothing to warn about', () => {
  const r = decideStop({ ...base, config: cfg('strict'), entries: [bash(10, 'ls'), usage(11, 1, 2, 3, 4)] });
  assert.equal(r.warning, null);
  assert.equal(r.block, false);
});

test('empty gate: gate problem skipped', () => {
  const r = decideStop({ ...base, config: cfg('strict', { gate: {} }), entries: [edit(100)] });
  assert.equal(r.warning, null);
  assert.equal(r.block, false);
});

test('scaffold: session.md older than last edit is a problem', () => {
  const config = cfg('guided', { state: 'scaffold' });
  const entries = [edit(100), bash(200, 'npm run build')];
  const stale = decideStop({ ...base, config, entries, sessionMdMtime: 50 });
  assert.equal(stale.warning, 'session.md older than last edit');
  const missing = decideStop({ ...base, config, entries, sessionMdMtime: null });
  assert.equal(missing.warning, 'session.md older than last edit');
  const fresh = decideStop({ ...base, config, entries, sessionMdMtime: 150 });
  assert.equal(fresh.warning, null);
});

test('scaffold: both problems are joined', () => {
  const r = decideStop({ ...base, config: cfg('guided', { state: 'scaffold' }), entries: [edit(100)], sessionMdMtime: 10 });
  assert.equal(r.warning, 'gate not run after last edit; session.md older than last edit');
});

test('session.md check only applies when a config was found', () => {
  const r = decideStop({ ...base, found: false, config: cfg('guided', { state: 'scaffold', gate: {} }), entries: [edit(100)], sessionMdMtime: 1 });
  assert.equal(r.warning, null);
});

const tool = (ts, name, command) => ({ ts, role: 'assistant', toolUses: [{ name, input: { command } }], usage: null, msgId: null });

test('a gate run through the PowerShell tool clears the gate problem', () => {
  const entries = [edit(100), tool(200, 'PowerShell', 'npm run build')];
  const r = decideStop({ ...base, config: cfg('strict'), entries });
  assert.deepEqual(r.problems, []);
  assert.equal(r.block, false);
});

test('a gate whose every value starts with ${ has no usable prefix: no gate problem', () => {
  const r = decideStop({ ...base, config: cfg('strict', { gate: { a: '${cmd}', b: '${x} --y' } }), entries: [edit(100)] });
  assert.deepEqual(r.problems, []);
  assert.equal(r.block, false);
});

const GATE_P = 'gate not run after last edit';
const SESSION_P = 'session.md older than last edit';

test('warn-once is per problem: an earlier warning never hides a different one', () => {
  const config = cfg('guided', { state: 'scaffold' });
  const gateOnly = decideStop({ ...base, config, entries: [edit(100)], sessionMdMtime: 150, warned: [] });
  assert.equal(gateOnly.warning, GATE_P);
  assert.deepEqual(gateOnly.warnedAfter, [GATE_P]);

  const sessionOnly = decideStop({ ...base, config, entries: [edit(100), bash(200, 'npm run build')], sessionMdMtime: 50, warned: gateOnly.warnedAfter });
  assert.equal(sessionOnly.warning, SESSION_P);
  assert.deepEqual(sessionOnly.warnedAfter, [GATE_P, SESSION_P]);

  const both = decideStop({ ...base, config, entries: [edit(100)], sessionMdMtime: 50, warned: [GATE_P] });
  assert.equal(both.warning, SESSION_P, 'only the problem not yet warned about');
  const again = decideStop({ ...base, config, entries: [edit(100)], sessionMdMtime: 50, warned: [GATE_P, SESSION_P] });
  assert.equal(again.warning, null);
  assert.deepEqual(again.warnedAfter, [GATE_P, SESSION_P]);
});

test('a non-array warned (old store) is treated as nothing warned yet', () => {
  for (const warned of [true, undefined, null, 'x']) {
    const r = decideStop({ ...base, warned, config: cfg('guided'), entries: [edit(100)] });
    assert.equal(r.warning, GATE_P, String(warned));
  }
});

const editAt = (ts, file_path, name = 'Edit') => ({ ts, role: 'assistant', toolUses: [{ name, input: { file_path } }], usage: null, msgId: null });

test('bookkeeping edits after the gate are not work (strict, scaffold)', () => {
  const config = cfg('strict', { state: 'scaffold', plan: { dir: 'docs/superpowers/plans' } });
  const entries = [
    editAt(100, 'D:/repo/src/a.js'),
    bash(200, 'npm run build'),
    editAt(300, 'D:/repo/.claude/state/session.md', 'Write'),
    editAt(400, 'D:/repo/.claude/state/completed.md'),
    editAt(500, 'D:/repo/.claude/state/backlog.md'),
    editAt(600, 'D:/repo/docs/superpowers/plans/p.md'),
  ];
  const r = decideStop({ ...base, cwd: 'D:/repo', config, entries, sessionMdMtime: 300 });
  assert.deepEqual(r.problems, []);
  assert.equal(r.block, false);
  const work = decideStop({ ...base, cwd: 'D:/repo', config, entries: [...entries, editAt(700, 'D:/repo/src/b.js')], sessionMdMtime: 300 });
  assert.deepEqual(work.problems, [GATE_P, SESSION_P]);
});
