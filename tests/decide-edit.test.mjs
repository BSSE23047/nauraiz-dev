import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideEdit, findRecordedApproval } from '../scripts/lib/decide-edit.mjs';

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

// --- approval check (a plan must not record an owner approval nobody gave) ---
const planCfg = (over = {}) => config({ plan: { dir: '.work/tasks' }, ...over });
const planFile = 'D:/repo/.work/tasks/12-example.md';

test('findRecordedApproval: recorded value with quotes stripped; pending or empty -> null', () => {
  assert.equal(findRecordedApproval('x: 1\nshared_layer_approval: owner kickoff 2026-10-31\n'), 'owner kickoff 2026-10-31');
  assert.equal(findRecordedApproval('approval: "yes"'), 'yes');
  assert.equal(findRecordedApproval("  new_files_approval: 'ok by owner'  "), 'ok by owner');
  assert.equal(findRecordedApproval('a_approval: pending owner confirmation'), null);
  assert.equal(findRecordedApproval('a_approval: "Pending owner confirmation"'), null);
  assert.equal(findRecordedApproval('a_approval:   '), null);
  assert.equal(findRecordedApproval('a_approval: ""'), null);
  assert.equal(findRecordedApproval('no approvals here\nmy_approvals: yes'), null);
  assert.equal(findRecordedApproval('pre-approval: yes'), null);
  assert.equal(findRecordedApproval('a_approval: pending\nb_approval: owner said so'), 'owner said so');
  assert.equal(findRecordedApproval(undefined), null);
});
test('a plan recording an approval -> ask naming the value', () => {
  const newText = '---\nshared_layer_approval: owner kickoff 2026-10-31\n---\n';
  const r = decideEdit({ cwd, filePath: planFile, config: planCfg(), found: true, plan, newText });
  assert.equal(r.decision, 'ask');
  assert.equal(r.reason, 'nauraiz-dev: this plan records an approval: "owner kickoff 2026-10-31". Did the owner give it in this session? If not, write "pending owner confirmation".');
});
test('a pending approval in a plan -> allow', () => {
  const newText = '---\nshared_layer_approval: "pending owner confirmation"\n---\n';
  assert.equal(decideEdit({ cwd, filePath: planFile, config: planCfg(), found: true, plan, newText }).decision, 'allow');
});
test('an Edit whose new_string is only the approval line still asks (guided and strict)', () => {
  for (const enforcement of ['guided', 'strict']) {
    const r = decideEdit({ cwd, filePath: planFile, config: planCfg({ enforcement }), found: true, plan, newText: 'new_files_approval: owner ok' });
    assert.equal(r.decision, 'ask', enforcement);
  }
});
test('advisory never asks about an approval', () => {
  const r = decideEdit({ cwd, filePath: planFile, config: planCfg({ enforcement: 'advisory' }), found: true, plan, newText: 'a_approval: owner ok' });
  assert.equal(r.decision, 'allow');
});
test('an approval line in a non-plan file is not asked about', () => {
  const r = decideEdit({ cwd, filePath: 'D:/repo/src/a.md', config: planCfg(), found: true, plan: null, newText: 'a_approval: owner ok' });
  assert.equal(r.decision, 'allow');
});
test('a .md under tasks/ or plans/ counts as a plan even outside plan.dir', () => {
  for (const filePath of ['D:/repo/docs/plans/x.md', 'D:/repo/tasks/x.md', 'D:/repo/plans/x.md', 'D:/repo/a/tasks/b/x.md']) {
    const r = decideEdit({ cwd, filePath, config: config(), found: true, plan: null, newText: 'a_approval: owner ok' });
    assert.equal(r.decision, 'ask', filePath);
  }
  const notMd = decideEdit({ cwd, filePath: 'D:/repo/docs/plans/x.txt', config: config(), found: true, plan: null, newText: 'a_approval: owner ok' });
  assert.equal(notMd.decision, 'allow');
});
test('a protected path with an approval line -> deny wins', () => {
  const r = decideEdit({ cwd, filePath: planFile, config: planCfg({ protectedPaths: ['.work/tasks/**'] }), found: true, plan, newText: 'a_approval: owner ok' });
  assert.equal(r.decision, 'deny');
});
test('no newText (e.g. NotebookEdit) or no approval line -> plan edit stays bookkeeping-allowed', () => {
  assert.equal(decideEdit({ cwd, filePath: planFile, config: planCfg(), found: true, plan }).decision, 'allow');
  assert.equal(decideEdit({ cwd, filePath: planFile, config: planCfg(), found: true, plan, newText: 'just text' }).decision, 'allow');
});
