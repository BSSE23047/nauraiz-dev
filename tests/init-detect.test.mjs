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

test('new fields default safely when nothing is detected', () => {
  const d = detect(fx('empty'));
  assert.deepEqual(d.offeredGate, {});
  assert.equal(d.testOneShot, null);
  assert.deepEqual(d.sharedPaths, []);
  assert.deepEqual(d.planKinds, []);
  const missing = detect(path.join(os.tmpdir(), 'nd-detect-does-not-exist'));
  assert.deepEqual(missing.offeredGate, {});
  assert.equal(missing.testOneShot, null);
  assert.deepEqual(missing.sharedPaths, []);
  assert.deepEqual(missing.planKinds, []);
});

test('offeredGate lists check-like npm scripts and Makefile targets, not the gate or test', () => {
  const d = detect(fx('detect-rich'));
  assert.deepEqual(d.gate, { build: 'npm run build', test: 'npm run test', lint: 'npm run lint' });
  assert.deepEqual(d.offeredGate, {
    check: 'npm run check',
    typecheck: 'npm run typecheck',
    'verify:docs': 'npm run verify:docs',
    'test:e2e': 'npm run test:e2e',
  });
  assert.ok(!('start' in d.offeredGate));
  assert.ok(!('test' in d.offeredGate));
});

test('offeredGate reads Makefile targets at column 0 when not already gated', (t) => {
  const dir = tmpRepo(t, {
    Makefile: 'check:\r\n\tgo vet ./...\r\n\ttest:\n\tnot-a-target\nlint: deps\n\tgolint\ntest:\n\tgo test ./...\nbuild:\n\tgo build\n',
  });
  const d = detect(dir);
  assert.equal(d.stack, 'unknown');
  assert.deepEqual(d.offeredGate, { check: 'make check', lint: 'make lint', test: 'make test' });
  const gated = tmpRepo(t, {
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .', check: 'x' } }),
    Makefile: 'lint:\n\tx\ncheck:\n\tx\ntest:\n\tx\n',
  });
  assert.deepEqual(detect(gated).offeredGate, { check: 'npm run check', test: 'make test' });
});

test('testOneShot rewrites watch-mode test scripts', (t) => {
  assert.equal(detect(fx('detect-rich')).testOneShot, 'npx vitest run');
  const jest = tmpRepo(t, { 'package.json': JSON.stringify({ scripts: { test: 'jest --watch' } }) });
  assert.equal(detect(jest).testOneShot, 'npx jest --watchAll=false');
  const jestAll = tmpRepo(t, { 'package.json': JSON.stringify({ scripts: { test: 'jest --watchAll' } }) });
  assert.equal(detect(jestAll).testOneShot, 'npx jest --watchAll=false');
});

test('testOneShot stays null when the test script already runs once', (t) => {
  for (const script of ['vitest run', 'vitest --run', 'vitest run --coverage', 'node --test', 'jest', 'jest --ci', 'mocha']) {
    const dir = tmpRepo(t, { 'package.json': JSON.stringify({ scripts: { test: script } }) });
    assert.equal(detect(dir).testOneShot, null, script);
  }
  const noTest = tmpRepo(t, { 'package.json': JSON.stringify({ scripts: { build: 'vitest' } }) });
  assert.equal(detect(noTest).testOneShot, null);
});

test('sharedPaths collects sharedLayers/shared arrays from .claude and .claude/knowledge JSON, deduped', (t) => {
  const d = detect(fx('detect-rich'));
  assert.deepEqual(d.sharedPaths, ['src/core/**', 'src/api/**', 'packages/common/**']);
  assert.ok(!d.protectedPaths.includes('src/core/**'));
  const nested = tmpRepo(t, {
    '.claude/knowledge/deep/x.json': JSON.stringify({ shared: ['deep/**'] }),
    '.claude/knowledge/nested.json': JSON.stringify({ outer: { shared: ['inner/**'] } }),
    '.claude/bad.json': '{ nope',
  });
  assert.deepEqual(detect(nested).sharedPaths, []);
});

test('planKinds comes from the PLAN_TEMPLATE frontmatter kind line', (t) => {
  assert.deepEqual(detect(fx('detect-rich')).planKinds, ['feature', 'bugfix', 'chore', 'refactor']);
  const body = tmpRepo(t, { '.claude/templates/PLAN_TEMPLATE.md': '---\ntitle: x\n---\nkind: a | b\n' });
  assert.deepEqual(detect(body).planKinds, []);
  const none = tmpRepo(t, { '.claude/templates/PLAN_TEMPLATE.md': '# Plan\nkind: a | b\n' });
  assert.deepEqual(detect(none).planKinds, []);
  const crlf = tmpRepo(t, { '.claude/templates/PLAN_TEMPLATE.md': '---\r\nkind: x | y\r\n---\r\n' });
  assert.deepEqual(detect(crlf).planKinds, ['x', 'y']);
  const onlyComment = tmpRepo(t, { '.claude/templates/PLAN_TEMPLATE.md': '---\nkind: # later\n---\n' });
  assert.deepEqual(detect(onlyComment).planKinds, []);
});

test('CLI output includes the new fields', async () => {
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [script, fx('detect-rich')], { encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out)));
  });
  const d = JSON.parse(stdout);
  assert.equal(d.testOneShot, 'npx vitest run');
  assert.equal(d.offeredGate.check, 'npm run check');
  assert.deepEqual(d.planKinds, ['feature', 'bugfix', 'chore', 'refactor']);
});
