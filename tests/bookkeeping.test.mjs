import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBookkeeping, isUnderPlanDir } from '../scripts/lib/bookkeeping.mjs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const config = { plan: { dir: 'docs/superpowers/plans' } };

test('state files, .work/handoff.md and the plan dir are bookkeeping', () => {
  for (const rel of ['.claude/state/session.md', '.claude/state/backlog.md', '.claude/state/completed.md', '.work/handoff.md', 'docs/superpowers/plans/2026-01-01-x.md']) {
    assert.equal(isBookkeeping(rel, config), true, rel);
  }
});

test('work files are not bookkeeping', () => {
  for (const rel of ['src/a.js', 'docs/superpowers/specs/x.md', '.claude/nauraiz-dev.json', 'src/.claude/state/x.md', '.work/tasks/x.md', '.work/handoff.md.bak']) {
    assert.equal(isBookkeeping(rel, config), false, rel);
  }
});

test('plan dir comes from config; odd values never throw', () => {
  assert.equal(isBookkeeping('.work/tasks/12-example.md', { plan: { dir: '.work/tasks' } }), true);
  assert.equal(isBookkeeping('.work/tasks/12-example.md', { plan: { dir: './.work/tasks/' } }), true);
  for (const c of [undefined, null, {}, { plan: null }, { plan: { dir: 5 } }, { plan: { dir: '' } }, { plan: { dir: '.' } }, { plan: { dir: '../x' } }]) {
    assert.equal(isBookkeeping('src/a.js', c), false, JSON.stringify(c));
    assert.equal(isBookkeeping('.claude/state/session.md', c), true, JSON.stringify(c));
  }
});

test('an absolute plan dir inside cwd is recognised when cwd is given', () => {
  assert.equal(isBookkeeping('plans/p.md', { plan: { dir: 'D:/repo/plans' } }, 'D:/repo'), true);
});

test('isUnderPlanDir: only the plan dir, never state files or an outside dir', () => {
  assert.equal(isUnderPlanDir('docs/superpowers/plans/p.md', config), true);
  assert.equal(isUnderPlanDir('plans/p.md', { plan: { dir: 'D:/repo/plans' } }, 'D:/repo'), true);
  assert.equal(isUnderPlanDir('.claude/state/session.md', config), false);
  assert.equal(isUnderPlanDir('src/a.js', config), false);
  for (const c of [undefined, {}, { plan: { dir: 5 } }, { plan: { dir: '' } }, { plan: { dir: '.' } }, { plan: { dir: '../x' } }]) {
    assert.equal(isUnderPlanDir('src/a.js', c), false, JSON.stringify(c));
  }
});

test('paths under .git/ are bookkeeping, with or without cwd; a file merely named .git* is not', () => {
  for (const rel of ['.git/COMMIT_EDITMSG', '.git/info/exclude', '.git/hooks/pre-commit']) {
    assert.equal(isBookkeeping(rel, config), true, rel);
    assert.equal(isBookkeeping(rel, config, 'D:/no-such-repo'), true, rel);
  }
  for (const rel of ['.gitignore', '.github/workflows/ci.yml', 'src/.git-thing']) {
    assert.equal(isBookkeeping(rel, config), false, rel);
  }
});

test('a git dir placed inside the project (separate-git-dir) is bookkeeping too', (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'nd-bk-gitdir-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(path.join(repo, 'meta'));
  execFileSync('git', ['init', '-q', `--separate-git-dir=${path.join(repo, 'meta', 'gitdata')}`, repo], { stdio: 'ignore' });
  assert.equal(isBookkeeping('meta/gitdata/HEAD', config, repo), true);
  assert.equal(isBookkeeping('meta/other.txt', config, repo), false);
  assert.equal(isBookkeeping('meta/gitdata/HEAD', config), false); // without cwd only .git/ is known
});
