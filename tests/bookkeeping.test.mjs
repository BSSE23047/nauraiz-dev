import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBookkeeping } from '../scripts/lib/bookkeeping.mjs';

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
