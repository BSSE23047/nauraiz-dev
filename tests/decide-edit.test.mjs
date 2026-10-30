import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideEdit } from '../scripts/lib/decide-edit.mjs';

const cwd = 'D:/repo';
const config = (over = {}) => ({ enforcement: 'guided', protectedPaths: ['.env*', '**/Generated*/**'], ...over });
const plan = { path: 'D:/repo/.work/tasks/12-example.md', allowed: ['src/app/components/Sidebar/**', 'src/app/utils/access.js'] };

test('no config found -> allow even for .env', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/.env', config: config(), found: false, plan: null });
  assert.equal(r.decision, 'allow');
});
test('protected path -> deny naming the pattern', () => {
  const winPath = ['D:', 'repo', '.env'].join(String.fromCharCode(92));
  const r = decideEdit({ cwd, filePath: winPath, config: config(), found: true, plan: null });
  assert.equal(r.decision, 'deny');
  assert.equal(r.reason, 'nauraiz-dev: .env is protected (.env*)');
});
test('protected nested path matches a ** pattern', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/src/GeneratedApi/x.js', config: config(), found: true, plan: null });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /\*\*\/Generated\*\/\*\*/);
});
test('outside Allowed in guided -> ask', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/src/other.js', config: config(), found: true, plan });
  assert.equal(r.decision, 'ask');
  assert.equal(r.reason, `nauraiz-dev: src/other.js is outside the plan's Allowed list (${plan.path}). Edit the plan first or confirm.`);
});
test('inside Allowed -> allow', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/src/app/utils/access.js', config: config(), found: true, plan });
  assert.equal(r.decision, 'allow');
  const r2 = decideEdit({ cwd, filePath: 'D:/repo/src/app/components/Sidebar/deep/Item.jsx', config: config(), found: true, plan });
  assert.equal(r2.decision, 'allow');
});
test('advisory with a plan -> allow', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/src/other.js', config: config({ enforcement: 'advisory' }), found: true, plan });
  assert.equal(r.decision, 'allow');
});
test('empty Allowed list or no plan -> allow', () => {
  assert.equal(decideEdit({ cwd, filePath: 'D:/repo/src/other.js', config: config(), found: true, plan: { ...plan, allowed: [] } }).decision, 'allow');
  assert.equal(decideEdit({ cwd, filePath: 'D:/repo/src/other.js', config: config(), found: true, plan: null }).decision, 'allow');
});
test('strict also asks outside Allowed', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/src/other.js', config: config({ enforcement: 'strict' }), found: true, plan });
  assert.equal(r.decision, 'ask');
});
test('advisory never denies, not even .env (spec 6.6: context only)', () => {
  for (const filePath of ['D:/repo/.env', 'D:/repo/.env.local', 'D:/repo/src/GeneratedApi/x.js']) {
    const r = decideEdit({ cwd, filePath, config: config({ enforcement: 'advisory' }), found: true, plan });
    assert.equal(r.decision, 'allow', filePath);
  }
});
test('guided and strict deny .env', () => {
  for (const enforcement of ['guided', 'strict']) {
    const r = decideEdit({ cwd, filePath: 'D:/repo/.env', config: config({ enforcement }), found: true, plan: null });
    assert.equal(r.decision, 'deny', enforcement);
  }
});
test('uppercase .ENV is denied on Windows', { skip: process.platform !== 'win32' }, () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/.ENV', config: config(), found: true, plan: null });
  assert.equal(r.decision, 'deny');
});
test('a malformed protectedPaths entry does not throw', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/a.js', config: config({ protectedPaths: [null, 5, '.env*'] }), found: true, plan: null });
  assert.equal(r.decision, 'allow');
});
test('scopeAsk false -> never ask outside Allowed', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/src/other.js', config: config({ scopeAsk: false }), found: true, plan });
  assert.equal(r.decision, 'allow');
  const strict = decideEdit({ cwd, filePath: 'D:/repo/src/other.js', config: config({ enforcement: 'strict', scopeAsk: false }), found: true, plan });
  assert.equal(strict.decision, 'allow');
});
test('scopeAsk false still denies protected paths', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/.env', config: config({ scopeAsk: false }), found: true, plan });
  assert.equal(r.decision, 'deny');
});
test('scopeAsk only switches off on an explicit false', () => {
  for (const scopeAsk of [true, undefined, 'false', 0, null]) {
    const r = decideEdit({ cwd, filePath: 'D:/repo/src/other.js', config: config({ scopeAsk }), found: true, plan });
    assert.equal(r.decision, 'ask', `scopeAsk=${String(scopeAsk)}`);
  }
});
test('directory patterns protect what is inside them (gitignore semantics)', () => {
  for (const pattern of ['backend/', '/backend', 'backend']) {
    const r = decideEdit({ cwd, filePath: 'D:/repo/backend/x.js', config: config({ protectedPaths: [pattern] }), found: true, plan: null });
    assert.equal(r.decision, 'deny', pattern);
  }
});
test('bookkeeping files never trigger the scope ask (plan file, state, .work/handoff.md)', () => {
  const cfg = config({ plan: { dir: '.work/tasks' } });
  for (const filePath of [plan.path, 'D:/repo/.claude/state/session.md', 'D:/repo/.claude/state/backlog.md', 'D:/repo/.work/handoff.md']) {
    const r = decideEdit({ cwd, filePath, config: cfg, found: true, plan });
    assert.equal(r.decision, 'allow', filePath);
  }
  assert.equal(decideEdit({ cwd, filePath: 'D:/repo/src/other.js', config: cfg, found: true, plan }).decision, 'ask');
});
test('a protected pattern still denies a bookkeeping path', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/.claude/state/session.md', config: config({ protectedPaths: ['.claude/state/**'] }), found: true, plan });
  assert.equal(r.decision, 'deny');
});
