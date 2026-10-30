import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addExcludes } from '../scripts/init/exclude.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'init', 'exclude.mjs');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A temp git repo with one commit, at its real (symlink-free) path. */
function tmpRepo(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nd-excl-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

test('subfolder with a space: appends a repo-root-relative posix line once', (t) => {
  const repo = tmpRepo(t);
  const sub = path.join(repo, 'sub dir');
  mkdirSync(sub);
  const first = addExcludes(sub, ['.claude/nauraiz-dev.local.json']);
  assert.deepEqual(first.added, ['sub dir/.claude/nauraiz-dev.local.json']);
  assert.equal(path.resolve(first.file), path.join(repo, '.git', 'info', 'exclude'));
  const text = readFileSync(first.file, 'utf8');
  assert.match(text, /# nauraiz-dev \(local mode\)\n/);
  assert.ok(text.split('\n').includes('sub dir/.claude/nauraiz-dev.local.json'));
  assert.ok(!text.includes('\\'));

  const second = addExcludes(sub, ['.claude/nauraiz-dev.local.json']);
  assert.deepEqual(second.added, []);
  assert.equal(readFileSync(first.file, 'utf8'), text);

  const third = addExcludes(sub, ['.claude/nauraiz-dev.local.json', '.claude/settings.local.json']);
  assert.deepEqual(third.added, ['sub dir/.claude/settings.local.json']);
  assert.equal(readFileSync(first.file, 'utf8').split('# nauraiz-dev (local mode)').length - 1, 1, 'marker written once');
});

test('git actually ignores the excluded file', (t) => {
  const repo = tmpRepo(t);
  const sub = path.join(repo, 'sub dir');
  mkdirSync(path.join(sub, '.claude'), { recursive: true });
  writeFileSync(path.join(sub, '.claude', 'nauraiz-dev.local.json'), '{}');
  assert.match(git(repo, 'status', '--porcelain'), /sub dir/);
  addExcludes(sub, ['.claude/nauraiz-dev.local.json']);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
});

test('a prefix with # or glob characters is escaped so git still matches it literally', (t) => {
  const repo = tmpRepo(t);
  for (const name of ['#tmp', '[b] dir']) {
    const sub = path.join(repo, name);
    mkdirSync(path.join(sub, '.claude'), { recursive: true });
    writeFileSync(path.join(sub, '.claude', 'nauraiz-dev.local.json'), '{}');
    const r = addExcludes(sub, ['.claude/nauraiz-dev.local.json']);
    assert.deepEqual(r.added, [`${name.replace('#', '\\#').replace('[', '\\[')}/.claude/nauraiz-dev.local.json`]);
  }
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
});

test('the patterns themselves are not escaped; only the prefix is', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-excl-esc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args) => ({ code: 0, stdout: args.includes('--show-prefix') ? '!a*/\n' : 'gitdir\n', stderr: '' });
  assert.deepEqual(addExcludes(dir, ['*.json'], run).added, ['\\!a\\*/*.json']);
});

test('repo root cwd: pattern is unchanged; backslashes become posix', (t) => {
  const repo = tmpRepo(t);
  const r = addExcludes(repo, ['.claude\\nauraiz-dev.local.json']);
  assert.deepEqual(r.added, ['.claude/nauraiz-dev.local.json']);
});

test('keeps existing exclude content and appends after a missing trailing newline', (t) => {
  const repo = tmpRepo(t);
  const file = path.join(repo, '.git', 'info', 'exclude');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '*.log');
  addExcludes(repo, ['a.json']);
  const lines = readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[0], '*.log');
  assert.ok(lines.includes('a.json'));
});

test('creates info/exclude and its directory when missing', (t) => {
  const repo = tmpRepo(t);
  rmSync(path.join(repo, '.git', 'info'), { recursive: true, force: true });
  const r = addExcludes(repo, ['a.json']);
  assert.ok(existsSync(r.file));
});

test('worktree: writes to the common git dir, with the worktree-relative prefix', (t) => {
  const repo = tmpRepo(t);
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
  git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  mkdirSync(path.join(wt, 'pkg'));
  const r = addExcludes(path.join(wt, 'pkg'), ['.claude/settings.local.json']);
  assert.deepEqual(r.added, ['pkg/.claude/settings.local.json']);
  assert.equal(path.resolve(r.file), path.join(repo, '.git', 'info', 'exclude'));
  assert.ok(!existsSync(path.join(wt, '.git', 'info')), 'a worktree .git is a file, never a dir');
});

test('injectable runner: converts the prefix and uses the common dir it returns', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-excl-fake-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.includes('--show-prefix')) return { code: 0, stdout: 'a b/c/\n', stderr: '' };
    return { code: 0, stdout: 'gitdir\n', stderr: '' };
  };
  const r = addExcludes(dir, ['x.json'], run);
  assert.deepEqual(r.added, ['a b/c/x.json']);
  assert.equal(r.file, path.join(dir, 'gitdir', 'info', 'exclude'));
  assert.equal(calls.length, 2);
});

test('not a git repo: throws and writes nothing', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-excl-none-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
  assert.throws(() => addExcludes(dir, ['x.json'], run), /not a git repository/);
});

test('CLI prints the JSON result', (t) => {
  const repo = tmpRepo(t);
  const r = spawnSync(process.execPath, [script, '.claude/nauraiz-dev.local.json'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.added, ['.claude/nauraiz-dev.local.json']);
  assert.equal(path.resolve(out.file), path.join(repo, '.git', 'info', 'exclude'));
});

test('CLI outside a repo exits 1 with a message and no stdout', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-excl-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  const r = spawnSync(process.execPath, [script, 'x.json'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /nauraiz-dev/);
});
