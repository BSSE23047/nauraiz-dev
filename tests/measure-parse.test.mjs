import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStream, buildArgs, formatReport, settingsJson, DEFAULT_ALLOWED_TOOLS } from '../scripts/measure/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stream = readFileSync(path.join(here, 'fixtures', 'measure', 'stream.jsonl'), 'utf8');

test('parseStream: totals, usage deduped by message id, tolerant of bad and unknown lines', () => {
  const r = parseStream(stream);
  assert.equal(r.ms, 61000);
  assert.equal(r.costUsd, 0.4321);
  assert.deepEqual(r.tokens, { output: 150, cacheRead: 4500, cacheWrite: 300, input: 18 });
  assert.deepEqual(r.skills, ['nauraiz-dev:start-task', 'nauraiz-dev:grill']);
  assert.equal(r.questions, 1);
  assert.deepEqual(r.edits, ['src/a.js', 'src/b.js', 'nb/n.ipynb']);
  assert.equal(r.turns, 3);
  assert.equal(r.subtype, 'success');
  assert.equal(r.isError, false);
  assert.equal(r.pluginCopies, 1);
});

test('parseStream: turns fall back to distinct assistant message ids; no result line gives null time and cost', () => {
  const noResult = stream.split('\n').filter((l) => !l.includes('"type":"result"')).join('\n');
  const r = parseStream(noResult);
  assert.equal(r.turns, 3);
  assert.equal(r.ms, null);
  assert.equal(r.costUsd, null);
});

test('parseStream: empty and garbage input give zeros, never throw', () => {
  for (const text of ['', '\n\nnope\n{"type":', undefined]) {
    const r = parseStream(text);
    assert.deepEqual(r, { ms: null, costUsd: null, tokens: { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 }, skills: [], questions: 0, edits: [], turns: 0, subtype: null, isError: false, pluginCopies: 0 });
  }
});

test('parseStream: a tool_use repeated with the same id is counted once', () => {
  const line = '{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"AskUserQuestion","input":{}}]}}';
  assert.equal(parseStream(`${line}\n${line}`).questions, 1);
});

test('buildArgs: prompt not in argv, shared safety flags, settings file for both arms, plugin dir for with only', () => {
  const common = { model: 'sonnet', budgetUsd: 3, pluginDir: '/p/x', settingsFile: '/s/settings.json' };
  const base = ['-p', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '3',
    '--permission-mode', 'acceptEdits', '--allowedTools', DEFAULT_ALLOWED_TOOLS, '--settings', '/s/settings.json'];
  assert.deepEqual(buildArgs({ arm: 'with', ...common }), [...base, '--plugin-dir', '/p/x']);
  assert.deepEqual(buildArgs({ arm: 'without', ...common }), base);
  assert.ok(buildArgs({ arm: 'with', ...common, allowedTools: 'Read Glob' }).includes('Read Glob'));
  assert.deepEqual(JSON.parse(settingsJson()), { enabledPlugins: { 'nauraiz-dev@nauraiz-dev': false } });
  assert.throws(() => buildArgs({ arm: 'both', model: 'm', budgetUsd: 1 }), /arm/);
});

test('default allowed tools: the owner-ruled list, read-only gh, no push', () => {
  const tools = DEFAULT_ALLOWED_TOOLS;
  for (const t of ['Read', 'Glob', 'Grep', 'Bash(npm *)', 'Bash(git commit *)', 'Bash(gh issue view *)', 'Bash(gh api user*)', 'Bash(gh search *)']) assert.ok(tools.includes(t), t);
  assert.doesNotMatch(tools, /git push|gh pr create|Write|Edit/);
});

const fullArm = (extra = {}) => ({ ...parseStream(stream), files: ['src/a.js', 'src/b.js'], approvals: 2, exit: 0, ...extra });

test('formatReport: a table of every field per arm, the commands, safety, gate results and the n=1 line', () => {
  const w = fullArm();
  const wo = fullArm({ ms: 90500, costUsd: 0.9, skills: [], questions: 0, turns: 5, pluginCopies: 0, approvals: 0, files: [] });
  const prompt = 'Work on issue #7 on branch b.';
  const md = formatReport({
    date: '2026-10-31', task: 'Issue 7', prompt, model: 'sonnet', arms: { with: w, without: wo },
    gate: { with: { ok: true, results: [] }, without: { ok: false, results: [{ name: 'test', status: 'fail', why: 'exit 1' }] } },
    budgetUsd: 3,
  });
  assert.match(md, /^# Measure: Issue 7/m);
  assert.match(md, /2026-10-31/);
  assert.ok(md.includes('| metric | with | without |'), "| metric | with | without |");
  for (const row of ['result', 'time', 'cost (USD)', 'output tokens', 'cache read tokens', 'cache write tokens', 'input tokens', 'turns',
    'questions (AskUserQuestion calls only)', 'skills invoked', 'nauraiz-dev copies loaded', 'files touched', 'approvals recorded', 'gate', 'claude exit code']) {
    assert.ok(md.includes(`| ${row} |`), `row ${row}`);
  }
  assert.ok(md.includes('| result | success | success |'), "| result | success | success |");
  assert.ok(md.includes('| time | 61.0 s | 90.5 s |'), "| time | 61.0 s | 90.5 s |");
  assert.ok(md.includes('| output tokens | 150 | 150 |'), "| output tokens | 150 | 150 |");
  assert.ok(md.includes('| skills invoked | nauraiz-dev:start-task, nauraiz-dev:grill | none |'), "| skills invoked | nauraiz-dev:start-task, nauraiz-dev:grill | none |");
  assert.ok(md.includes('| nauraiz-dev copies loaded | 1 | 0 |'), "| nauraiz-dev copies loaded | 1 | 0 |");
  assert.ok(md.includes('| files touched | src/a.js, src/b.js | none |'), "| files touched | src/a.js, src/b.js | none |");
  assert.ok(md.includes('| approvals recorded | 2 | 0 |'), "| approvals recorded | 2 | 0 |");
  assert.ok(md.includes('| gate | pass | fail (test: exit 1) |'), "| gate | pass | fail (test: exit 1) |");
  assert.ok(md.includes(prompt));
  assert.match(md, /--plugin-dir <plugin-dir>/);
  assert.match(md, /--settings <settings-file>/);
  assert.match(md, /< <prompt-file>/);
  assert.match(md, /--max-budget-usd 3/);
  assert.match(md, /--permission-mode acceptEdits/);
  assert.ok(md.includes(DEFAULT_ALLOWED_TOOLS));
  assert.ok(md.includes('git remote set-url --push origin DISABLED-by-nauraiz-measure'));
  assert.ok(!md.includes('/p/x'));
  assert.ok(md.trimEnd().endsWith('n=1 per arm; not a benchmark.'));
});

test('formatReport: a missing gate shows not run, a missing result shows n/a and FAILED', () => {
  const empty = { ...parseStream(''), exit: null };
  const md = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: empty, without: empty }, gate: {} });
  assert.ok(md.includes('| gate | not run | not run |'), "| gate | not run | not run |");
  assert.ok(md.includes('| time | n/a | n/a |'), "| time | n/a | n/a |");
  assert.ok(md.includes('| result | FAILED: no result line in the stream |'), "| result | FAILED: no result line in the stream |");
});

test('formatReport: an error result subtype, a timeout and a failed run are flagged', () => {
  const overBudget = fullArm({ subtype: 'error_max_budget_usd', isError: true });
  const killed = fullArm({ timedOut: 30, subtype: null });
  const md = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: overBudget, without: killed }, failed: 'claude could not be started for the with arm (ENOENT)' });
  assert.ok(md.includes('| result | FAILED: error_max_budget_usd (is_error) | FAILED: killed after the 30 min timeout |'), "| result | FAILED: error_max_budget_usd (is_error) | FAILED: killed after the 30 min timeout |");
  assert.ok(md.startsWith('**FAILED: claude could not be started for the with arm (ENOENT).'));
});

test('measure skill: owner-only, short description, confirms budget and total cap, states the prompt', () => {
  const text = readFileSync(path.join(here, '..', 'skills', 'measure', 'SKILL.md'), 'utf8');
  const fm = text.split('---\n')[1];
  assert.match(fm, /^disable-model-invocation: true$/m);
  const desc = /^description: "(.*)"$/m.exec(fm)[1];
  assert.ok(desc.length <= 200, `description is ${desc.length} chars`);
  for (const needle of ['approximate total cap', '2 x budget', 'WARNING:', 'docs/measure/*.jsonl', '--allow-high-budget', '--timeout-min', 'sonnet', '3 USD', 'Work on issue #N on branch B.']) {
    assert.ok(text.includes(needle), `skill must mention ${needle}`);
  }
});
