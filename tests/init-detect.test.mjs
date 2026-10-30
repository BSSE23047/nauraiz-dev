import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fx } from './helpers.mjs';
import { detect } from '../scripts/init/detect.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'init', 'detect.mjs');

/** A fresh temp repo with `files` ({ relPath: content }); removed after the test. */
function tmpRepo(t, files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-detect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    if (content !== null) writeFileSync(file, content);
  }
  return dir;
}

test('npm app', () => {
  const d = detect(fx('npm-app'));
  assert.equal(d.stack, 'node');
  assert.deepEqual(d.gate, { build: 'npm run build', test: 'npm run test', lint: 'npm run lint' });
  assert.ok(d.protectedPaths.includes('**/Generated*/**'));
  assert.ok(d.protectedPaths.includes('.env*'));
  assert.equal(d.existingPreToolUseHook, true);
});

test('flutter app', () => {
  const d = detect(fx('flutter-app'));
  assert.equal(d.stack, 'flutter');
  assert.deepEqual(d.gate, { analyze: 'flutter analyze', test: 'flutter test' });
  assert.equal(d.existingPreToolUseHook, false);
});

test('empty', () => {
  const d = detect(fx('empty'));
  assert.equal(d.stack, 'unknown');
  assert.deepEqual(d.gate, {});
  assert.deepEqual(d.protectedPaths, ['.env*']);
  assert.deepEqual(d.claudeMd, { exists: false, lines: 0 });
  assert.equal(d.hasState, false);
  assert.equal(d.hasWorkTasks, false);
  assert.equal(typeof d.baseBranch, 'string');
  assert.ok(d.baseBranch.length > 0);
});

test('state and plan folders are detected', () => {
  assert.equal(detect(fx('scaffold')).hasState, true);
  assert.equal(detect(fx('planned')).hasWorkTasks, true);
});

test('node wins when package.json and pubspec.yaml both exist', (t) => {
  const dir = tmpRepo(t, {
    'package.json': JSON.stringify({ scripts: { test: 'x' } }),
    'pubspec.yaml': 'name: both\n',
  });
  const d = detect(dir);
  assert.equal(d.stack, 'node');
  assert.deepEqual(d.gate, { test: 'npm run test' });
});

test('CLAUDE.md lines are counted', (t) => {
  const dir = tmpRepo(t, { 'CLAUDE.md': '# A\n\nline 3\n' });
  assert.deepEqual(detect(dir).claudeMd, { exists: true, lines: 3 });
  const crlf = tmpRepo(t, { 'CLAUDE.md': 'one\r\ntwo' });
  assert.deepEqual(detect(crlf).claudeMd, { exists: true, lines: 2 });
});

test('outside a git repo the base branch is main', (t) => {
  assert.equal(detect(tmpRepo(t)).baseBranch, 'main');
});

test('a PreToolUse hook that never sees edits does not count', (t) => {
  const dir = tmpRepo(t, {
    '.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] } }),
  });
  assert.equal(detect(dir).existingPreToolUseHook, false);
  const any = tmpRepo(t, {
    '.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } }),
  });
  assert.equal(detect(any).existingPreToolUseHook, true);
});

test('unreadable or malformed files are treated as absent, never thrown', (t) => {
  const dir = tmpRepo(t, {
    'package.json': '{ not json',
    '.claude/settings.json': '[]',
    '.claude/knowledge/protected-paths.json': JSON.stringify({ frameworkOwned: ['ok/**', 5, null] }),
    'CLAUDE.md/.keep': '',
  });
  const d = detect(dir);
  assert.equal(d.stack, 'unknown');
  assert.deepEqual(d.gate, {});
  assert.equal(d.existingPreToolUseHook, false);
  assert.deepEqual(d.protectedPaths, ['.env*', 'ok/**']);
  assert.deepEqual(d.claudeMd, { exists: false, lines: 0 });
});

test('a missing directory still returns the full shape', () => {
  const d = detect(path.join(os.tmpdir(), 'nd-detect-does-not-exist'));
  assert.equal(d.stack, 'unknown');
  assert.equal(d.baseBranch, 'main');
});

test('CLI prints the detection as JSON', async () => {
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [script, fx('npm-app')], { encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out)));
  });
  const d = JSON.parse(stdout);
  assert.equal(d.stack, 'node');
  assert.equal(d.gate.lint, 'npm run lint');
});
