import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fx, runHook } from './helpers.mjs';
import { readTranscript, lastEditTs } from '../scripts/lib/transcript.mjs';

const sample = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcript.sample.jsonl');
const EDIT_TS = lastEditTs(readTranscript(sample));
const STDERR = 'nauraiz-dev strict: session.md is older than your last edit; run /nauraiz-dev:handoff, then /compact.';

// Hooks must never touch the real data dir: each test gets a throwaway CLAUDE_PLUGIN_DATA.
async function withData(fn) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-pc-data-'));
  try { return await fn(data); } finally { fs.rmSync(data, { recursive: true, force: true }); }
}

/** Temp repo with the given config; sessionMtime (ms) creates session.md at that mtime, null leaves it absent. */
function tempRepo(config, sessionMtime = null) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-pc-repo-'));
  fs.mkdirSync(path.join(repo, '.claude', 'state'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'nauraiz-dev.json'), JSON.stringify(config));
  if (sessionMtime !== null) {
    const file = path.join(repo, '.claude', 'state', 'session.md');
    fs.writeFileSync(file, '# session\n');
    fs.utimesSync(file, sessionMtime / 1000, sessionMtime / 1000);
  }
  return repo;
}

const strict = { enforcement: 'strict', state: 'scaffold' };
const payload = (repo, trigger) => ({ session_id: 's1', transcript_path: sample, cwd: repo, trigger, hook_event_name: 'PreCompact' });

test('sample transcript has an edit timestamp', () => {
  assert.ok(Number.isFinite(EDIT_TS));
});

test('unconfigured repo: no output, exit 0', () => withData(async (data) => {
  const r = await runHook('pre-compact', payload(fx('empty'), 'manual'), { CLAUDE_PLUGIN_DATA: data });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
}));

test('guided manual with stale session.md: no output, exit 0', () => withData(async (data) => {
  const repo = tempRepo({ enforcement: 'guided', state: 'scaffold' }, EDIT_TS - 60_000);
  try {
    const r = await runHook('pre-compact', payload(repo, 'manual'), { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('strict auto with stale session.md never blocks', () => withData(async (data) => {
  const repo = tempRepo(strict, EDIT_TS - 60_000);
  try {
    const r = await runHook('pre-compact', payload(repo, 'auto'), { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('strict manual with stale session.md: exit 2 with the exact stderr', () => withData(async (data) => {
  const repo = tempRepo(strict, EDIT_TS - 60_000);
  try {
    const r = await runHook('pre-compact', payload(repo, 'manual'), { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.trim(), STDERR);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('strict manual with session.md missing: exit 2', () => withData(async (data) => {
  const repo = tempRepo(strict, null);
  try {
    const r = await runHook('pre-compact', payload(repo, 'manual'), { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), STDERR);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('strict manual with session.md newer than the last edit: exit 0', () => withData(async (data) => {
  const repo = tempRepo(strict, EDIT_TS + 60_000);
  try {
    const r = await runHook('pre-compact', payload(repo, 'manual'), { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('strict manual with no edits in the transcript: exit 0', () => withData(async (data) => {
  const repo = tempRepo(strict, 1000);
  try {
    const r = await runHook('pre-compact', { ...payload(repo, 'manual'), transcript_path: '/nope/missing.jsonl' }, { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('strict but state not scaffold: exit 0', () => withData(async (data) => {
  const repo = tempRepo({ enforcement: 'strict', state: 'none' }, EDIT_TS - 60_000);
  try {
    const r = await runHook('pre-compact', payload(repo, 'manual'), { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.code, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));

test('garbage stdin never throws', () => withData(async (data) => {
  const r = await runHook('pre-compact', 'not json', { CLAUDE_PLUGIN_DATA: data });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
}));

test('strict manual: edits to completed/backlog after session.md do not block', () => withData(async (data) => {
  const now = Date.now();
  const repo = tempRepo(strict, now);
  const state = (n) => path.join(repo, '.claude', 'state', n);
  const line = (ts, name, input) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
  try {
    const transcript = path.join(repo, 'transcript.jsonl');
    fs.writeFileSync(transcript, [
      line(now - 120_000, 'Edit', { file_path: path.join(repo, 'src', 'a.js') }),
      line(now - 90_000, 'Write', { file_path: state('session.md') }),
      line(now + 30_000, 'Edit', { file_path: state('completed.md') }),
      line(now + 40_000, 'Edit', { file_path: state('backlog.md') }),
    ].join('\n') + '\n');
    const r = await runHook('pre-compact', { ...payload(repo, 'manual'), transcript_path: transcript }, { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}));
