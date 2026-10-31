import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CONTEXT_CHARS } from '../scripts/lib/config.mjs';
import { fx, runHook } from './helpers.mjs';

test('scaffold repo emits SessionStart additionalContext within the cap', async () => {
  const { stdout, code } = await runHook('session-start', { cwd: fx('scaffold'), source: 'startup' });
  assert.equal(code, 0);
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  assert.ok(out.additionalContext.length <= MAX_CONTEXT_CHARS);
  assert.match(out.additionalContext, /## session\.md/);
});

test('unconfigured repo still gets the header', async () => {
  const { stdout } = await runHook('session-start', { cwd: fx('empty'), source: 'resume' });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /no project config/);
});

test('garbage stdin exits 0 quietly or with a header, never throws', async () => {
  const r = await runHook('session-start', 'not json');
  assert.equal(r.code, 0);
});

test('a config problem is also shown to the user as a systemMessage', async () => {
  for (const name of ['broken', 'bad-local']) {
    const out = JSON.parse((await runHook('session-start', { cwd: fx(name), source: 'startup' })).stdout);
    assert.match(out.systemMessage, /^nauraiz-dev: config problem — .*nauraiz-dev(\.local)?\.json/, name);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(out.hookSpecificOutput.additionalContext.length > 0);
  }
  for (const name of ['empty', 'configured']) {
    const out = JSON.parse((await runHook('session-start', { cwd: fx(name), source: 'startup' })).stdout);
    assert.equal(out.systemMessage, undefined, name);
  }
});

const START_LINE = 'Task start: run /nauraiz-dev:start-task on the first substantive request (checks who owns the issue, asks before building, routes the process); to push and open a PR: /nauraiz-dev:ship.';

test('local-only repo gets mode=local, the gate line with the expanded plugin root and the start-task line', async () => {
  const { stdout } = await runHook('session-start', { cwd: fx('local-only'), source: 'startup' }, { CLAUDE_PLUGIN_ROOT: 'D:\\plugins\\nauraiz dev' });
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx.split('\n')[0], / · mode=local$/);
  assert.equal(ctx.split('\n')[1], START_LINE);
  assert.match(ctx, /^Gate: test \(run node "D:\/plugins\/nauraiz dev\/scripts\/gate\/run\.mjs"/m);
});

test('local-only repo without CLAUDE_PLUGIN_ROOT gets the /nauraiz-dev:gate pointer', async () => {
  const { stdout } = await runHook('session-start', { cwd: fx('local-only'), source: 'startup' }, { CLAUDE_PLUGIN_ROOT: '' });
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^Gate: test \(run \/nauraiz-dev:gate once, from any folder in the project; /m);
  assert.doesNotMatch(ctx, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});
