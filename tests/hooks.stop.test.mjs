import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fx, runHook } from './helpers.mjs';
import { sessionStore } from '../scripts/lib/session-store.mjs';

const sample = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcript.sample.jsonl');

// Ruling R6: every test gets its own throwaway CLAUDE_PLUGIN_DATA; the real data dir is never touched.
async function withData(fn) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-stop-data-'));
  try { return await fn(data); } finally { fs.rmSync(data, { recursive: true, force: true }); }
}

function tempRepo(config) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-stop-repo-'));
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'nauraiz-dev.json'), JSON.stringify(config));
  return repo;
}

test('stop_hook_active true: exits 0 with no output', () => withData(async (data) => {
  const r = await runHook('stop', { stop_hook_active: true, session_id: 's1', transcript_path: sample, cwd: fx('empty') }, { CLAUDE_PLUGIN_DATA: data });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
}));

test('prints the cost line from the sample transcript', () => withData(async (data) => {
  const r = await runHook('stop', { session_id: 's1', transcript_path: sample, cwd: fx('empty') }, { CLAUDE_PLUGIN_DATA: data });
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /nauraiz-dev · tokens/);
}));

test('cost line includes subagent totals and elapsed minutes from the session layout', () => withData(async (data) => {
  const transcript = path.join(path.dirname(sample), 'session', 'sess-1.jsonl');
  const r = await runHook('stop', { session_id: 's1', transcript_path: transcript, cwd: fx('empty') }, { CLAUDE_PLUGIN_DATA: data });
  assert.match(JSON.parse(r.stdout).systemMessage, /main out 3k, cache read 110k, cache write 5k, input 30 · subagents out 4k, cache read 120k · 2 min wall/);
}));

test('garbage stdin and missing transcript never throw', () => withData(async (data) => {
  const bad = await runHook('stop', 'not json', { CLAUDE_PLUGIN_DATA: data });
  assert.equal(bad.code, 0);
  const none = await runHook('stop', { session_id: 's1', transcript_path: '/nope/missing.jsonl', cwd: fx('empty') }, { CLAUDE_PLUGIN_DATA: data });
  assert.equal(none.code, 0);
  assert.match(JSON.parse(none.stdout).systemMessage, /tokens this session: main out 0, cache read 0, cache write 0, input 0/);
}));

test('guided, gate ran after the last edit: no warning', () => withData(async (data) => {
  const repo = tempRepo({ enforcement: 'guided', gate: { build: 'npm run build' } });
  try {
    const r = await runHook('stop', { session_id: 's1', transcript_path: sample, cwd: repo }, { CLAUDE_PLUGIN_DATA: data });
    const msg = JSON.parse(r.stdout).systemMessage;
    assert.doesNotMatch(msg, /gate not run/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('guided, gate not run after the last edit: warns once, then stays quiet', () => withData(async (data) => {
  const repo = tempRepo({ enforcement: 'guided', gate: { test: 'npm test' } });
  try {
    const payload = { session_id: 'sess/1', transcript_path: sample, cwd: repo };
    const first = await runHook('stop', payload, { CLAUDE_PLUGIN_DATA: data });
    assert.match(JSON.parse(first.stdout).systemMessage, /⚠ gate not run after last edit/);
    const second = await runHook('stop', payload, { CLAUDE_PLUGIN_DATA: data });
    assert.doesNotMatch(JSON.parse(second.stdout).systemMessage, /gate not run/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('strict, gate not run: blocks every time with only the decision JSON', () => withData(async (data) => {
  const repo = tempRepo({ enforcement: 'strict', gate: { test: 'npm test' } });
  try {
    const payload = { session_id: 's2', transcript_path: sample, cwd: repo };
    for (let i = 0; i < 2; i++) {
      const r = await runHook('stop', payload, { CLAUDE_PLUGIN_DATA: data });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block');
      assert.equal(out.reason, 'nauraiz-dev strict: gate not run after last edit. Run the gate / write the handoff, then stop.');
      assert.equal(out.systemMessage, undefined);
    }
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('strict with stop_hook_active: lets the stop through (no loop)', () => withData(async (data) => {
  const repo = tempRepo({ enforcement: 'strict', gate: { test: 'npm test' } });
  try {
    const r = await runHook('stop', { stop_hook_active: true, session_id: 's3', transcript_path: sample, cwd: repo }, { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.stdout, '');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('sessionStore: round-trips, merges patches, sanitises ids, tolerates garbage', () => withData(async (data) => {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data;
  try {
    const s = sessionStore('a/b:c');
    assert.deepEqual(s.get(), {});
    s.set({ warned: true });
    s.set({ other: 1 });
    assert.deepEqual(sessionStore('a/b:c').get(), { warned: true, other: 1 });
    assert.ok(fs.existsSync(path.join(data, 'sessions', 'a_b_c.json')));
    fs.writeFileSync(path.join(data, 'sessions', 'bad.json'), '{oops');
    assert.deepEqual(sessionStore('bad').get(), {});
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
}));

// I2 helpers: a transcript written next to a temp repo, with absolute file paths inside it.
const line = (ts, name, input) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
function scaffoldRepo(config) {
  const repo = tempRepo({ state: 'scaffold', gate: { test: 'npm test' }, ...config });
  fs.mkdirSync(path.join(repo, '.claude', 'state'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'state', 'session.md'), '# Session\n');
  return repo;
}
const writeTranscript = (repo, lines) => {
  const file = path.join(repo, 'transcript.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

test('strict: gate, then session.md, then completed/backlog edits -> no block', () => withData(async (data) => {
  const repo = scaffoldRepo({ enforcement: 'strict' });
  const now = Date.now();
  const state = (n) => path.join(repo, '.claude', 'state', n);
  try {
    const transcript = writeTranscript(repo, [
      line(now - 120_000, 'Edit', { file_path: path.join(repo, 'src', 'a.js') }),
      line(now - 100_000, 'Bash', { command: 'npm test' }),
      line(now - 90_000, 'Write', { file_path: state('session.md') }),
      line(now + 30_000, 'Edit', { file_path: state('completed.md') }),
      line(now + 40_000, 'Edit', { file_path: state('backlog.md') }),
    ]);
    const r = await runHook('stop', { session_id: 'i2-a', transcript_path: transcript, cwd: repo }, { CLAUDE_PLUGIN_DATA: data });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, undefined, r.stdout);
    assert.doesNotMatch(out.systemMessage, /⚠/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('guided: a second, different problem is still warned after the first warning', () => withData(async (data) => {
  const repo = scaffoldRepo({ enforcement: 'guided' });
  const now = Date.now();
  try {
    const edit = line(now - 120_000, 'Edit', { file_path: path.join(repo, 'src', 'a.js') });
    const payload = { session_id: 'i2-b', cwd: repo };
    // 1: gate not run, session.md fresh -> gate warning
    const first = await runHook('stop', { ...payload, transcript_path: writeTranscript(repo, [edit]) }, { CLAUDE_PLUGIN_DATA: data });
    assert.match(JSON.parse(first.stdout).systemMessage, /⚠ gate not run after last edit$/);
    // 2: gate run, session.md now stale -> the handoff warning must still appear
    const sessionMd = path.join(repo, '.claude', 'state', 'session.md');
    fs.utimesSync(sessionMd, (now - 200_000) / 1000, (now - 200_000) / 1000);
    const second = await runHook('stop', { ...payload, transcript_path: writeTranscript(repo, [edit, line(now - 100_000, 'Bash', { command: 'npm test' })]) }, { CLAUDE_PLUGIN_DATA: data });
    assert.match(JSON.parse(second.stdout).systemMessage, /⚠ session\.md older than last edit$/);
    // 3: same problem again -> quiet
    const third = await runHook('stop', { ...payload, transcript_path: writeTranscript(repo, [edit, line(now - 100_000, 'Bash', { command: 'npm test' })]) }, { CLAUDE_PLUGIN_DATA: data });
    assert.doesNotMatch(JSON.parse(third.stdout).systemMessage, /⚠/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('subagent usage totals are cached in the session store and reused on the next stop', () => withData(async (data) => {
  const transcript = path.join(path.dirname(sample), 'session', 'sess-1.jsonl');
  const payload = { session_id: 'cache-1', transcript_path: transcript, cwd: fx('empty') };
  await runHook('stop', payload, { CLAUDE_PLUGIN_DATA: data });
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data;
  try {
    const cache = sessionStore('cache-1').get().subagentUsage;
    const keys = Object.keys(cache ?? {});
    assert.equal(keys.length, 1);
    assert.equal(cache[keys[0]].totals.output, 4000);
    // plant different totals under the same size+mtime: the hook must trust the cache, not re-read
    cache[keys[0]].totals = { input: 0, output: 7000, cacheRead: 9000, cacheWrite: 0, total: 16000 };
    sessionStore('cache-1').set({ subagentUsage: cache });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
  const r = await runHook('stop', payload, { CLAUDE_PLUGIN_DATA: data });
  assert.match(JSON.parse(r.stdout).systemMessage, / · subagents out 7k, cache read 9k · /);
}));
