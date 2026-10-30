import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBase } from '../scripts/lib/base.mjs';

// Stub of the git calls resolveBase makes: `refs` maps a full ref name to a sha, `ancestors` lists
// "<ancestor>..<descendant>" pairs for merge-base --is-ancestor.
function stub(refs, ancestors = []) {
  return (args) => {
    if (args[0] === 'rev-parse') {
      const ref = args[args.length - 1];
      return ref in refs ? { code: 0, stdout: refs[ref] + '\n' } : { code: 1, stdout: '' };
    }
    if (args[0] === 'merge-base') {
      const [a, b] = args.slice(-2);
      return { code: ancestors.includes(`${a}..${b}`) ? 0 : 1, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };
}

test('local branch missing: origin/<base>', () => {
  assert.equal(resolveBase('.', 'dev', stub({ 'refs/remotes/origin/dev': 'aaa' })), 'origin/dev');
});
test('local branch behind origin: origin/<base>', () => {
  const run = stub({ 'refs/heads/dev': 'aaa', 'refs/remotes/origin/dev': 'bbb' }, ['refs/heads/dev..refs/remotes/origin/dev']);
  assert.equal(resolveBase('.', 'dev', run), 'origin/dev');
});
test('local ahead of or diverged from origin: the local branch', () => {
  assert.equal(resolveBase('.', 'dev', stub({ 'refs/heads/dev': 'aaa', 'refs/remotes/origin/dev': 'bbb' })), 'dev');
});
test('local equal to origin: the local branch', () => {
  const run = stub({ 'refs/heads/dev': 'aaa', 'refs/remotes/origin/dev': 'aaa' }, ['refs/heads/dev..refs/remotes/origin/dev']);
  assert.equal(resolveBase('.', 'dev', run), 'dev');
});
test('an origin/ base is returned unchanged and git is not called', () => {
  const run = () => { throw new Error('must not run'); };
  assert.equal(resolveBase('.', 'origin/dev', run), 'origin/dev');
});
test('git failing gives the base unchanged', () => {
  assert.equal(resolveBase('.', 'dev', () => { throw new Error('no git'); }), 'dev');
  assert.equal(resolveBase('.', 'dev', () => ({ code: 128, stdout: '' })), 'dev');
});

test('real repo: a stale local branch resolves to the remote one, a fresh one stays', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nd-base-'));
  try {
    const git = (cwd, ...a) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    const origin = path.join(root, 'origin repo');
    const clone = path.join(root, 'clone');
    git(root, 'init', '-q', '-b', 'dev', origin);
    writeFileSync(path.join(origin, 'a.txt'), '1');
    git(origin, 'add', '.'); git(origin, 'commit', '-q', '-m', 'one');
    git(root, 'clone', '-q', origin, clone);
    assert.equal(resolveBase(clone, 'dev'), 'dev');
    writeFileSync(path.join(origin, 'a.txt'), '2');
    git(origin, 'commit', '-q', '-am', 'two');
    git(clone, 'fetch', '-q');
    assert.equal(resolveBase(clone, 'dev'), 'origin/dev');
    assert.equal(resolveBase(clone, 'nope-branch'), 'origin/nope-branch'); // local missing, per contract
  } finally { rmSync(root, { recursive: true, force: true }); }
});
