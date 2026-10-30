import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readTranscript, readSubagentEntries, subagentUsage, elapsedMinutes, lastEditTs, lastGateTs, gatePrefixes, tokenTotals } from '../scripts/lib/transcript.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sample = path.join(dir, 'transcript.sample.jsonl');
const bad = path.join(dir, 'transcript.bad-line.jsonl');

test('one entry per line in the sample, missing file gives []', () => {
  assert.equal(readTranscript(sample).length, 40);
  assert.deepEqual(readTranscript(path.join(dir, 'nope.jsonl')), []);
});

test('unparsable lines are skipped', () => {
  assert.equal(readTranscript(bad).length, readTranscript(sample).length);
});

test('entries carry numeric ts, role, toolUses and usage', () => {
  const entries = readTranscript(sample);
  const edits = entries.flatMap((e) => e.toolUses).filter((t) => t.name === 'Edit');
  assert.equal(edits.length, 2);
  assert.equal(edits[0].input.file_path, '/repo/src/a.js');
  assert.ok(entries.some((e) => e.role === 'assistant' && e.usage?.output > 0));
  assert.ok(entries.some((e) => e.role === 'user'));
  assert.ok(entries.every((e) => e.ts === null || Number.isFinite(e.ts)));
  assert.ok(entries.some((e) => e.ts === null), 'sample has lines without a timestamp');
});

test('lastEditTs is the latest Edit timestamp; null without edits', () => {
  const entries = readTranscript(sample);
  assert.equal(lastEditTs(entries), Date.parse('2026-08-07T10:47:52.907Z'));
  assert.equal(lastEditTs([]), null);
  assert.equal(lastEditTs(entries.filter((e) => !e.toolUses.some((t) => t.name === 'Edit'))), null);
});

test('lastGateTs finds the build after the last edit', () => {
  const entries = readTranscript(sample);
  assert.equal(lastGateTs(entries, { build: 'npm run build' }), Date.parse('2026-08-07T11:02:18.229Z'));
  assert.ok(lastGateTs(entries, { build: 'npm run build' }) > lastEditTs(entries));
});

test('lastGateTs uses the prefix before ${ and ignores empty gates', () => {
  const entries = readTranscript(sample);
  assert.equal(lastGateTs(entries, { b: 'npm run build ${path}' }), Date.parse('2026-08-07T11:02:18.229Z'));
  assert.equal(lastGateTs(entries, {}), null);
  assert.equal(lastGateTs(entries, { x: '${all}' }), null);
  assert.equal(lastGateTs(entries, { x: 'npm run nonexistent' }), null);
});

test('timestamps out of file order: max ts wins, null ts ignored', () => {
  const bash = (command) => [{ name: 'Bash', input: { command } }];
  const entries = [
    { ts: 300, role: 'assistant', toolUses: [{ name: 'Write', input: {} }], usage: null },
    { ts: 100, role: 'assistant', toolUses: [{ name: 'Edit', input: {} }], usage: null },
    { ts: null, role: 'assistant', toolUses: [{ name: 'MultiEdit', input: {} }], usage: null },
    { ts: 200, role: 'assistant', toolUses: bash('npm test'), usage: null },
    { ts: 250, role: 'assistant', toolUses: bash('npm test'), usage: null },
  ];
  assert.equal(lastEditTs(entries), 300);
  assert.equal(lastGateTs(entries, { t: 'npm test' }), 250);
});

test('tokenTotals counts each message.id once', () => {
  // Independent pass over the raw JSON, deduping by message.id.
  const seen = new Set();
  const want = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let dupes = 0;
  for (const line of readFileSync(sample, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const u = JSON.parse(line).message?.usage;
    if (!u) continue;
    const id = JSON.parse(line).message.id;
    if (seen.has(id)) { dupes++; continue; }
    seen.add(id);
    want.input += u.input_tokens ?? 0;
    want.output += u.output_tokens ?? 0;
    want.cacheRead += u.cache_read_input_tokens ?? 0;
    want.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }
  assert.ok(dupes > 0, 'sample must contain repeated message ids');
  const got = tokenTotals(readTranscript(sample));
  assert.deepEqual(got, { ...want, total: want.input + want.output + want.cacheRead + want.cacheWrite });
  assert.ok(got.total > 0);
});

test('tokenTotals: lines without message.id count individually; empty input is zeros', () => {
  const u = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
  const entries = [
    { ts: null, role: 'assistant', toolUses: [], usage: u },
    { ts: null, role: 'assistant', toolUses: [], usage: u },
  ];
  assert.deepEqual(tokenTotals(entries), { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 });
  assert.deepEqual(tokenTotals([]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test('lastGateTs counts any tool whose input.command is a string (PowerShell on Windows)', () => {
  const entries = [
    { ts: 100, role: 'assistant', toolUses: [{ name: 'Edit', input: {} }], usage: null },
    { ts: 200, role: 'assistant', toolUses: [{ name: 'PowerShell', input: { command: 'npm test' } }], usage: null },
    { ts: 300, role: 'assistant', toolUses: [{ name: 'Read', input: { file_path: 'npm test' } }], usage: null },
  ];
  assert.equal(lastGateTs(entries, { t: 'npm test' }), 200);
});

test('gatePrefixes: usable text before ${, trimmed, empty ones dropped', () => {
  assert.deepEqual(gatePrefixes({ a: 'npm test', b: 'npm run build ${path}', c: '${all}', d: '  ', e: 5 }), ['npm test', 'npm run build', 'scripts/gate/run.mjs']);
  assert.deepEqual(gatePrefixes(undefined), []);
  assert.deepEqual(gatePrefixes({ x: '${cmd} --flag' }), []);
});

test('lastEditTs with { cwd, exclude } skips edits whose relative path is excluded', () => {
  const ed = (ts, name, input) => ({ ts, role: 'assistant', toolUses: [{ name, input }], usage: null });
  const entries = [
    ed(100, 'Edit', { file_path: 'D:\\repo\\src\\a.js' }),
    ed(200, 'Write', { file_path: 'D:/repo/.claude/state/session.md' }),
    ed(300, 'NotebookEdit', { notebook_path: 'D:/repo/notes/n.ipynb' }),
    ed(400, 'Edit', { file_path: 'D:/repo/.claude/state/backlog.md' }),
  ];
  const exclude = (rel) => rel.startsWith('.claude/state/') || rel === 'notes/n.ipynb';
  assert.equal(lastEditTs(entries, { cwd: 'D:/repo', exclude }), 100);
  assert.equal(lastEditTs(entries), 400, 'the old signature still counts every edit');
  assert.equal(lastEditTs([ed(500, 'Edit', {})], { cwd: 'D:/repo', exclude: () => true }), 500, 'an edit with no path still counts');
});

test('gatePrefixes: a usable gate also counts a runner call, no gate stays none', () => {
  assert.deepEqual(gatePrefixes({}), []);
  assert.deepEqual(gatePrefixes({ t: 'npm test' }), ['npm test', 'scripts/gate/run.mjs']);
});

const sessionDir = path.join(dir, 'session');

test('readSubagentEntries reads every subagent jsonl, ignores meta files, missing dir gives []', () => {
  const entries = readSubagentEntries(path.join(sessionDir, 'sess-1.jsonl'));
  assert.equal(entries.length, 2);
  const t = tokenTotals(entries);
  assert.equal(t.output, 4000);
  assert.equal(t.cacheRead, 120000);
  assert.deepEqual(readSubagentEntries(sample), []);
  assert.deepEqual(readSubagentEntries(''), []);
});

test('elapsedMinutes rounds first-to-last timestamp to minutes, null under two timestamps', () => {
  const at = (ts) => ({ ts, role: 'user', toolUses: [], usage: null, msgId: null });
  assert.equal(elapsedMinutes([at(0), at(90000)]), 2);
  assert.equal(elapsedMinutes([at(0), at(10000)]), 0);
  assert.equal(elapsedMinutes([at(90000), at(null), at(0)]), 2);
  assert.equal(elapsedMinutes([at(5)]), null);
  assert.equal(elapsedMinutes([at(null), at(null)]), null);
  assert.equal(elapsedMinutes([]), null);
});

test('elapsedMinutes handles 200k timestamps without a stack overflow', () => {
  const many = Array.from({ length: 200_000 }, (_, i) => ({ ts: i * 10, role: 'user', toolUses: [], usage: null, msgId: null }));
  assert.equal(elapsedMinutes(many), Math.round((199_999 * 10) / 60000));
});

test('subagentUsage sums per-file totals, caches them by path+size+mtime and reuses a matching cache entry', () => {
  const transcript = path.join(sessionDir, 'sess-1.jsonl');
  const first = subagentUsage(transcript);
  assert.equal(first.totals.output, 4000);
  assert.equal(first.totals.cacheRead, 120000);
  assert.equal(first.partial, false);
  const keys = Object.keys(first.cache);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /agent-a\.jsonl$/);
  const entry = first.cache[keys[0]];
  assert.equal(typeof entry.size, 'number');
  assert.equal(typeof entry.mtimeMs, 'number');

  // a cache entry with the same size and mtime is trusted: the file is not re-read
  const planted = { [keys[0]]: { ...entry, totals: { input: 1, output: 7, cacheRead: 9, cacheWrite: 0, total: 17 } } };
  const second = subagentUsage(transcript, { cache: planted });
  assert.equal(second.totals.output, 7);
  assert.equal(second.totals.cacheRead, 9);

  // a stale entry (size differs) is re-read
  const stale = { [keys[0]]: { ...entry, size: entry.size + 1, totals: { input: 1, output: 7, cacheRead: 9, cacheWrite: 0, total: 17 } } };
  assert.equal(subagentUsage(transcript, { cache: stale }).totals.output, 4000);

  // no dir: zero totals, empty cache
  const none = subagentUsage(sample);
  assert.equal(none.totals.total, 0);
  assert.deepEqual(none.cache, {});
});

test('subagentUsage stops reading past maxBytes and reports partial; cached files cost no bytes', () => {
  const transcript = path.join(sessionDir, 'sess-1.jsonl');
  const capped = subagentUsage(transcript, { maxBytes: 10 });
  assert.equal(capped.partial, true);
  assert.equal(capped.totals.output, 0);
  const warm = subagentUsage(transcript).cache;
  const cachedRun = subagentUsage(transcript, { cache: warm, maxBytes: 10 });
  assert.equal(cachedRun.partial, false);
  assert.equal(cachedRun.totals.output, 4000);
});
