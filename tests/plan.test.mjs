import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePlan, findPlanForBranch } from '../scripts/lib/plan.mjs';
import { currentBranch } from '../scripts/lib/git.mjs';
import { fx, read } from './helpers.mjs';

const PLAN = 'planned/.work/tasks/12-example.md';

test('parses frontmatter, allowed and handoff', () => {
  const p = parsePlan(read(PLAN));
  assert.equal(p.branch, 'feature/12-example');
  assert.deepEqual(p.allowed, ['src/app/components/Sidebar/**', 'src/app/utils/access.js']);
  assert.equal(p.handoff.trim(), 'Next: wire the header.');
});

test('parses CRLF input identically', () => {
  const p = parsePlan(read(PLAN).replace(/\r?\n/g, '\r\n'));
  assert.equal(p.branch, 'feature/12-example');
  assert.deepEqual(p.allowed, ['src/app/components/Sidebar/**', 'src/app/utils/access.js']);
  assert.equal(p.handoff.trim(), 'Next: wire the header.');
});

test('strips one pair of matching quotes from frontmatter values', () => {
  assert.equal(parsePlan('---\nbranch: "feature/12-example"\n---\n').branch, 'feature/12-example');
  assert.equal(parsePlan("---\nbranch: 'feature/x'\n---\n").branch, 'feature/x');
});

test('frontmatter only counts when the first line is ---', () => {
  const p = parsePlan('# Title\n---\nbranch: feature/x\n---\n');
  assert.equal(p.branch, null);
});

test('allowed items keep only the path, drop trailing commentary and empties', () => {
  const p = parsePlan('### Allowed\n- `src/a.js` — main file\n- \n- `  `\n- src/b.js\n');
  assert.deepEqual(p.allowed, ['src/a.js', 'src/b.js']);
});

test('allowed stops at the next heading; missing sections give empty/null', () => {
  const p = parsePlan('### Allowed\n- a\n## Other\n- b\n');
  assert.deepEqual(p.allowed, ['a']);
  assert.equal(p.handoff, null);
  assert.deepEqual(parsePlan(''), { branch: null, allowed: [], handoff: null });
});

test('handoff runs until the next ## heading', () => {
  const p = parsePlan('## Handoff\nline 1\nline 2\n## After\nnope\n');
  assert.equal(p.handoff.trim(), 'line 1\nline 2');
});

test('handoff keeps ### subheadings', () => {
  const p = parsePlan('## Handoff\n### Next\nwire it\n');
  assert.equal(p.handoff.trim(), '### Next\nwire it');
});

test('finds plan by branch, null otherwise', () => {
  assert.ok(findPlanForBranch(fx('planned'), '.work/tasks', 'feature/12-example'));
  assert.equal(findPlanForBranch(fx('planned'), '.work/tasks', 'main'), null);
  assert.equal(findPlanForBranch(fx('empty'), '.work/tasks', 'main'), null);
});

test('found plan carries its path and parsed fields', () => {
  const found = findPlanForBranch(fx('planned'), '.work/tasks', 'feature/12-example');
  assert.equal(path.basename(found.path), '12-example.md');
  assert.deepEqual(found.allowed, ['src/app/components/Sidebar/**', 'src/app/utils/access.js']);
  assert.equal(found.handoff.trim(), 'Next: wire the header.');
});

test('currentBranch reads HEAD, returns null for non-repos and detached HEAD', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-git-'));
  try {
    assert.equal(currentBranch(dir), null);
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    git('init', '-q', '-b', 'feature/x');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    assert.equal(currentBranch(dir), 'feature/x');
    git('checkout', '-q', '--detach');
    assert.equal(currentBranch(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
