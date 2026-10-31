import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fx, runHook } from './helpers.mjs';

const decisionOf = (stdout) => JSON.parse(stdout).hookSpecificOutput;

test('deny on .env with windows path', async () => {
  const { stdout, code } = await runHook('pre-tool-use', { cwd: fx('configured'), tool_name: 'Edit', tool_input: { file_path: fx('configured') + '\\.env' } });
  const out = decisionOf(stdout);
  assert.equal(code, 0);
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /^nauraiz-dev: \.env is protected/);
});
test('no file_path exits quietly', async () => {
  const r = await runHook('pre-tool-use', { cwd: fx('configured'), tool_name: 'Write', tool_input: {} });
  assert.deepEqual([r.stdout, r.code], ['', 0]);
});
test('notebook_path is honoured', async () => {
  const { stdout } = await runHook('pre-tool-use', { cwd: fx('configured'), tool_name: 'NotebookEdit', tool_input: { notebook_path: fx('configured') + '/.env.nb' } });
  assert.equal(decisionOf(stdout).permissionDecision, 'deny');
});
test('unconfigured repo never denies', async () => {
  const r = await runHook('pre-tool-use', { cwd: fx('empty'), tool_name: 'Edit', tool_input: { file_path: fx('empty') + '/.env' } });
  assert.deepEqual([r.stdout, r.code], ['', 0]);
});
test('unconfigured repo hook run is fast', async () => {
  const t = Date.now();
  await runHook('pre-tool-use', { cwd: fx('empty'), tool_name: 'Edit', tool_input: { file_path: fx('empty') + '/a.js' } });
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});
test('empty or non-JSON stdin exits 0 with no output', async () => {
  for (const input of ['', 'not json', '[]', 'null']) {
    const r = await runHook('pre-tool-use', input);
    assert.deepEqual([r.stdout, r.code], ['', 0], JSON.stringify(input));
  }
});
test('non-string file_path and missing cwd never throw', async () => {
  const r = await runHook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: 5 } });
  assert.deepEqual([r.stdout, r.code], ['', 0]);
});

test('guided plan scope: ask outside Allowed, silent inside', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.claude'));
  writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), '{"enforcement":"guided"}');
  mkdirSync(path.join(dir, '.work', 'tasks'), { recursive: true });
  copyFileSync(path.join(fx('planned'), '.work', 'tasks', '12-example.md'), path.join(dir, '.work', 'tasks', '12-example.md'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('checkout', '-q', '-b', 'feature/12-example');
  // currentBranch needs a born HEAD (rev-parse fails on an empty repo)
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');

  const ask = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'other.js') } });
  const out = decisionOf(ask.stdout);
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /src\/other\.js is outside the plan's Allowed list/);

  const ok = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'app', 'utils', 'access.js') } });
  assert.deepEqual([ok.stdout, ok.code], ['', 0]);
});

test('a throw during plan lookup still denies protected paths', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.claude'));
  writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), '{"enforcement":"guided","plan":{"dir":5}}');
  // a real branch is needed so the plan lookup actually reaches path.resolve
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('checkout', '-q', '-b', 'feature/12-example');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
  const r = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.env') } });
  assert.equal(r.code, 0);
  assert.equal(decisionOf(r.stdout).permissionDecision, 'deny');
});

test('advisory config never denies, not even .env', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.claude'));
  writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), '{"enforcement":"advisory","protectedPaths":[".env*"]}');
  const r = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.env') } });
  assert.deepEqual([r.stdout, r.code], ['', 0]);
});

test('guided plan scope: editing the plan, state files or .work/handoff.md never asks', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-'));
  const data = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-data-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });
  mkdirSync(path.join(dir, '.claude'));
  writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), '{"enforcement":"guided"}');
  mkdirSync(path.join(dir, '.work', 'tasks'), { recursive: true });
  copyFileSync(path.join(fx('planned'), '.work', 'tasks', '12-example.md'), path.join(dir, '.work', 'tasks', '12-example.md'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('checkout', '-q', '-b', 'feature/12-example');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const rel of [['.work', 'tasks', '12-example.md'], ['.claude', 'state', 'session.md'], ['.work', 'handoff.md']]) {
    const r = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, ...rel) } }, { CLAUDE_PLUGIN_DATA: data });
    assert.deepEqual([r.stdout, r.code], ['', 0], rel.join('/'));
  }
});

test('unreadable project config still denies .env* and asks nothing else', async (t) => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-data-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const env = { CLAUDE_PLUGIN_DATA: data };
  const deny = await runHook('pre-tool-use', { cwd: fx('broken'), tool_name: 'Edit', tool_input: { file_path: path.join(fx('broken'), '.env.local') } }, env);
  assert.equal(deny.code, 0);
  const out = decisionOf(deny.stdout);
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /\.env\.local is protected \(\.env\*\)/);
  const other = await runHook('pre-tool-use', { cwd: fx('broken'), tool_name: 'Edit', tool_input: { file_path: path.join(fx('broken'), 'src', 'a.js') } }, env);
  assert.deepEqual([other.stdout, other.code], ['', 0]);
});

test('approval in a plan: Write, Edit and MultiEdit ask; pending is silent', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.claude'));
  writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), '{"enforcement":"guided"}');
  mkdirSync(path.join(dir, '.work', 'tasks'), { recursive: true });
  copyFileSync(path.join(fx('planned'), '.work', 'tasks', '12-example.md'), path.join(dir, '.work', 'tasks', '12-example.md'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('checkout', '-q', '-b', 'feature/12-example');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');

  const file_path = path.join(dir, '.work', 'tasks', '12-example.md');
  const approved = 'shared_layer_approval: owner kickoff 2026-10-31';
  const cases = [
    { tool_name: 'Write', tool_input: { file_path, content: `---\n${approved}\n---\n` } },
    { tool_name: 'Edit', tool_input: { file_path, old_string: 'branch: feature/12-example', new_string: `branch: feature/12-example
${approved}` } },
    { tool_name: 'MultiEdit', tool_input: { file_path, edits: [{ old_string: '# Plan', new_string: '# Plan 2' }, { old_string: 'task: Example task', new_string: `task: Example task
${approved}` }] } },
  ];
  for (const c of cases) {
    const r = await runHook('pre-tool-use', { cwd: dir, ...c });
    assert.equal(r.code, 0);
    const out = decisionOf(r.stdout);
    assert.equal(out.permissionDecision, 'ask', c.tool_name);
    assert.match(out.permissionDecisionReason, /records an approval: "owner kickoff 2026-10-31"/);
  }
  const pending = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path, old_string: 'task: Example task', new_string: 'task: Example task\nshared_layer_approval: pending owner confirmation' } });
  assert.deepEqual([pending.stdout, pending.code], ['', 0]);
});

test('approval in a plan: value-only Edit, unchanged approvals and unrelated edits', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.claude'));
  writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), '{"enforcement":"guided"}');
  mkdirSync(path.join(dir, '.work', 'tasks'), { recursive: true });
  const file_path = path.join(dir, '.work', 'tasks', '12-example.md');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('checkout', '-q', '-b', 'feature/12-example');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');

  writeFileSync(file_path, '---\ntitle: a\nshared_layer_approval: "pending owner confirmation"\n---\n');
  const flip = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path, old_string: 'pending owner confirmation', new_string: 'owner kickoff' } });
  assert.equal(decisionOf(flip.stdout).permissionDecision, 'ask');
  assert.match(decisionOf(flip.stdout).permissionDecisionReason, /"owner kickoff"/);
  const multi = await runHook('pre-tool-use', { cwd: dir, tool_name: 'MultiEdit', tool_input: { file_path, edits: [{ old_string: 'title: a', new_string: 'title: b' }, { old_string: 'pending owner confirmation', new_string: 'owner kickoff' }] } });
  assert.equal(decisionOf(multi.stdout).permissionDecision, 'ask');

  writeFileSync(file_path, '---\ntitle: a\nshared_layer_approval: owner kickoff\n---\n');
  const unrelated = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path, old_string: 'title: a', new_string: 'title: b' } });
  assert.deepEqual([unrelated.stdout, unrelated.code], ['', 0]);
  const rewrite = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Write', tool_input: { file_path, content: '---\ntitle: c\nshared_layer_approval: owner kickoff\n---\nbody\n' } });
  assert.deepEqual([rewrite.stdout, rewrite.code], ['', 0]);
});

test('unreadable local-only config still denies .env* and asks nothing else', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-badlocal-'));
  const data = mkdtempSync(path.join(os.tmpdir(), 'nd-pretool-data-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });
  mkdirSync(path.join(dir, '.claude'));
  writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.local.json'), '{ not json');
  const env = { CLAUDE_PLUGIN_DATA: data };
  const deny = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, '.env'), content: 'X=1' } }, env);
  assert.equal(deny.code, 0);
  const out = decisionOf(deny.stdout);
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /\.env is protected \(\.env\*\)/);
  const other = await runHook('pre-tool-use', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'a.js') } }, env);
  assert.deepEqual([other.stdout, other.code], ['', 0]);
});
