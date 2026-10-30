import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, runHook } from './helpers.mjs';

test('scaffold repo injects project rules and gate names into the subagent', async () => {
  const { stdout, code } = await runHook('subagent-start', { cwd: fx('scaffold'), agent_type: 'general-purpose' });
  assert.equal(code, 0);
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SubagentStart');
  assert.match(out.additionalContext, /# Project rules \(nauraiz-dev\)/);
  assert.match(out.additionalContext, /Gate commands: build, test/);
});

test('unconfigured repo prints nothing', async () => {
  const { stdout, code } = await runHook('subagent-start', { cwd: fx('empty') });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('garbage stdin exits 0 without throwing', async () => {
  const r = await runHook('subagent-start', 'not json');
  assert.equal(r.code, 0);
});
