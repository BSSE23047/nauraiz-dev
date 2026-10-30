import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStream, buildArgs, formatReport } from '../scripts/measure/parse.mjs';

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
    assert.deepEqual(r, { ms: null, costUsd: null, tokens: { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 }, skills: [], questions: 0, edits: [], turns: 0 });
  }
});

test('parseStream: a tool_use repeated with the same id is counted once', () => {
  const line = '{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"AskUserQuestion","input":{}}]}}';
  assert.equal(parseStream(`${line}\n${line}`).questions, 1);
});

test('buildArgs: shared flags, plugin dir for with, inline settings JSON for without', () => {
  const base = ['-p', 'Do it', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '3'];
  assert.deepEqual(buildArgs({ arm: 'with', prompt: 'Do it', model: 'sonnet', budgetUsd: 3, pluginDir: '/p/x' }), [...base, '--plugin-dir', '/p/x']);
  const without = buildArgs({ arm: 'without', prompt: 'Do it', model: 'sonnet', budgetUsd: 3, pluginDir: '/p/x' });
  assert.deepEqual(without.slice(0, base.length), base);
  assert.equal(without[base.length], '--settings');
  assert.deepEqual(JSON.parse(without[base.length + 1]), { enabledPlugins: { 'nauraiz-dev@nauraiz-dev': false } });
  assert.equal(without.length, base.length + 2);
  assert.ok(!without.includes('--plugin-dir'));
  assert.throws(() => buildArgs({ arm: 'both', prompt: 'x', model: 'm', budgetUsd: 1 }), /arm/);
});

test('formatReport: a table of every field per arm, the commands, gate results and the n=1 line', () => {
  const w = parseStream(stream);
  const wo = { ...w, ms: 90500, costUsd: 0.9, skills: [], questions: 0, turns: 5 };
  const prompt = 'Work on issue #7 on branch b.';
  const md = formatReport({
    date: '2026-10-31', task: 'Issue 7', prompt, model: 'sonnet',
    arms: { with: w, without: wo },
    gate: { with: { ok: true, results: [] }, without: { ok: false, results: [{ name: 'test', status: 'fail', why: 'exit 1' }] } },
    budgetUsd: 3, pluginDir: '/p/x',
  });
  assert.match(md, /^# Measure: Issue 7/m);
  assert.match(md, /2026-10-31/);
  assert.match(md, /\| metric \| with \| without \|/);
  for (const row of ['time', 'cost (USD)', 'output tokens', 'cache read tokens', 'cache write tokens', 'input tokens', 'turns', 'questions asked', 'skills invoked', 'files touched', 'gate']) {
    assert.ok(md.includes(`| ${row} |`), `row ${row}`);
  }
  assert.match(md, /\| time \| 61\.0 s \| 90\.5 s \|/);
  assert.match(md, /\| output tokens \| 150 \| 150 \|/);
  assert.match(md, /\| skills invoked \| nauraiz-dev:start-task, nauraiz-dev:grill \| none \|/);
  assert.match(md, /\| gate \| pass \| fail \(test: exit 1\) \|/);
  assert.ok(md.includes(prompt));
  assert.match(md, /--plugin-dir \/p\/x/);
  assert.match(md, /--settings '\{"enabledPlugins":\{"nauraiz-dev@nauraiz-dev":false\}\}'/);
  assert.match(md, /--max-budget-usd 3/);
  assert.ok(md.trimEnd().endsWith('n=1 per arm; not a benchmark.'));
});

test('formatReport: a missing gate shows not run, a missing result shows n/a', () => {
  const empty = parseStream('');
  const md = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: empty, without: empty }, gate: {} });
  assert.match(md, /\| gate \| not run \| not run \|/);
  assert.match(md, /\| time \| n\/a \| n\/a \|/);
});

test('measure skill: owner-only, short description, confirms budget and total cap, states the prompt', () => {
  const text = readFileSync(path.join(here, '..', 'skills', 'measure', 'SKILL.md'), 'utf8');
  const fm = text.split('---\n')[1];
  assert.match(fm, /^disable-model-invocation: true$/m);
  const desc = /^description: "(.*)"$/m.exec(fm)[1];
  assert.ok(desc.length <= 200, `description is ${desc.length} chars`);
  for (const needle of ['total cap', '2 x budget', 'sonnet', '3 USD', 'Work on issue #N on branch B.']) {
    assert.ok(text.includes(needle), `skill must mention ${needle}`);
  }
});
