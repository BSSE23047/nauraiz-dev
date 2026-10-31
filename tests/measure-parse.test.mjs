import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStream, buildArgs, formatReport, settingsJson, createTokenCounter, tokenCapNotEnforced, totalTokens, rawTokens, weightedTokens, DEFAULT_ALLOWED_TOOLS } from '../scripts/measure/parse.mjs';

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
  assert.equal(r.outputEstimated, false, 'the result line carries real usage');
  assert.equal(r.msFromStream, false);
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
    assert.deepEqual(r, { ms: null, msFromStream: false, costUsd: null, tokens: { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 }, outputEstimated: false, skills: [], questions: 0, edits: [], turns: 0, subtype: null, isError: false, pluginCopies: 0 });
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
  for (const t of ['Read', 'Glob', 'Grep', 'Bash(npm *)', 'Bash(git commit *)', 'Bash(pnpm *)', 'Bash(yarn *)', 'Bash(gh issue view *)', 'Bash(gh search *)']) assert.ok(tools.includes(t), t);
  const words = tools.split(' ');
  for (const t of ['Skill', 'Agent', 'AskUserQuestion', 'TodoWrite']) assert.ok(words.includes(t), `${t} must be allowed: under claude -p a tool that is not allowed is denied`);
  assert.doesNotMatch(tools, /git push|gh pr create|gh api/);
  assert.doesNotMatch(tools, /(^| )(Write|Edit|MultiEdit)( |$)/, 'no edit tool is pre-allowed: acceptEdits covers edits');
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
  for (const row of ['result', 'time', 'cost (USD)', 'output tokens', 'cache read tokens', 'cache write tokens', 'input tokens', 'tokens (weighted: cache reads at 0.1)', 'tokens (raw)', 'turns',
    'questions (AskUserQuestion calls only)', 'skills invoked', 'nauraiz-dev copies loaded', 'files touched', 'approvals recorded', 'gate', 'claude exit code']) {
    assert.ok(md.includes(`| ${row} |`), `row ${row}`);
  }
  assert.ok(md.includes('| result | success | success |'), "| result | success | success |");
  assert.ok(md.includes('| time | 61.0 s | 90.5 s |'), "| time | 61.0 s | 90.5 s |");
  assert.ok(md.includes('| output tokens | 150 | 150 |'), "| output tokens | 150 | 150 |");
  assert.ok(md.includes('| tokens (weighted: cache reads at 0.1) | 918 | 918 |'), md);
  assert.ok(md.includes('| tokens (raw) | 4968 | 4968 |'), md);
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
  assert.ok(md.includes('The questions row counts AskUserQuestion calls only'), 'questions note');
  assert.ok(md.includes('a PreToolUse `ask` from a hook is treated as a deny'), 'R14 probe note');
  assert.ok(md.includes('Only the disabled push URL is enforced'), 'safety note: what is enforced');
  assert.ok(md.includes('`node` and `npm` can run anything'), 'safety note: allow-list is convention');
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
  for (const needle of ['approximate total cap', '2 x budget', 'WARNING:', 'docs/measure/*.jsonl', '--allow-high-budget', '--timeout-min', '--setup', 'sonnet', '3 USD', 'Work on issue #N on branch B.',
    'counts AskUserQuestion calls only', 'a PreToolUse `ask` becomes a deny', 'Only the disabled push URL is enforced', '`{ "gate": { "gate": "<cmd>" } }`',
    'no result line']) {
    assert.ok(text.includes(needle), `skill must mention ${needle}`);
  }
});

const usageLine = (id, u, extra = {}) => JSON.stringify({ type: 'assistant', message: { id, usage: u, content: [], ...extra } });

test('createTokenCounter: sums input, output, cache creation and cache read, once per assistant message id', () => {
  const c = createTokenCounter();
  assert.equal(c.total(), 0);
  const m1 = usageLine('m1', { input_tokens: 1, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 });
  assert.equal(c.feed(`${m1}\n`), 721, 'weighted: 1 + 20 + 300 + 0.1 x 4000');
  assert.equal(c.raw(), 4321);
  assert.equal(c.weighted(), 721);
  assert.equal(c.feed(`${m1}\n${m1}\n`), 721, 'a repeated message id is not counted again');
  assert.equal(c.feed(`${usageLine('m2', { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 5 })}\n`), 731, 'weighted rounds down: 721 + 10 + 0.5');
  assert.equal(c.raw(), 4336);
  assert.equal(c.total(), 731);
});

test('createTokenCounter: a later line for the same id replaces the earlier usage (the same rule as parseStream)', () => {
  const c = createTokenCounter();
  c.feed(`${usageLine('m1', { output_tokens: 5 })}\n`);
  assert.equal(c.feed(`${usageLine('m1', { output_tokens: 50 })}\n`), 50);
});

test('createTokenCounter: lines split across chunks, bad lines, non-assistant lines and missing usage are tolerated', () => {
  const c = createTokenCounter();
  const line = usageLine('m1', { input_tokens: 7, output_tokens: 3 });
  assert.equal(c.feed(line.slice(0, 30)), 0, 'half a line counts nothing yet');
  assert.equal(c.feed(`${line.slice(30)}\nnot json\n{"type":"result","usage":{"output_tokens":999}}\n{"type":"user"}\n`), 10);
  assert.equal(c.feed(usageLine('m2', undefined)), 10, 'no usage object counts nothing');
  assert.equal(c.feed('\n'), 10);
  const noNewline = createTokenCounter();
  assert.equal(noNewline.feed(line), 10, 'a complete JSON line without its newline is counted now (stops earlier, never later)');
  assert.equal(noNewline.feed('\n'), 10);
  const junk = createTokenCounter();
  assert.equal(junk.feed(usageLine('m', { output_tokens: 'x', input_tokens: -1 })), 0);
});

test('createTokenCounter: agrees with parseStream (raw and weighted) on the fixture stream without its result line', () => {
  const noResult = stream.split('\n').filter((l) => !l.includes('"type":"result"')).join('\n');
  const c = createTokenCounter();
  const parsed = parseStream(noResult);
  assert.equal(c.feed(noResult), weightedTokens(parsed));
  assert.equal(c.raw(), rawTokens(parsed));
  assert.equal(parsed.outputEstimated, true);
});

test('buildArgs: --max-budget-usd is left out when there is no budget (token cap only)', () => {
  const args = buildArgs({ arm: 'with', model: 'sonnet', pluginDir: '/p', settingsFile: '/s' });
  assert.ok(!args.includes('--max-budget-usd'));
  assert.deepEqual(args.slice(0, 6), ['-p', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose']);
});

test('formatReport: the token cap in the header, a stopped-at-token-cap row, no --max-budget-usd without a budget', () => {
  const capped = fullArm({ stoppedAtTokenCap: true, subtype: null });
  const ok = fullArm();
  const md = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: capped, without: ok }, maxTokens: 2000000, budgetUsd: null });
  assert.match(md, /^Date: d\. Model: m\. Token cap: 2000000 weighted tokens per arm \(cache reads count 0\.1\)\.$/m);
  assert.ok(md.includes('| stopped at token cap | yes | no |'), md);
  assert.ok(md.includes('| result | FAILED: stopped at the token cap | success |'), md);
  assert.ok(!md.includes('--max-budget-usd'));
  assert.ok(!md.includes('<budget>'));
  const both = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: ok, without: ok }, maxTokens: 500, budgetUsd: 3 });
  assert.match(both, /Token cap: 500 weighted tokens per arm \(cache reads count 0\.1\)\. Budget cap: 3 USD per arm\./);
  assert.match(both, /--max-budget-usd 3/);
  const none = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: ok, without: ok }, budgetUsd: 3 });
  assert.ok(none.includes('| stopped at token cap | no | no |'));
  assert.ok(!none.includes('Token cap:'), 'no token cap line when none is set');
});

test('measure skill: explains both caps, the weighted 1,500,000 token default and confirms whichever caps apply', () => {
  const text = readFileSync(path.join(here, '..', 'skills', 'measure', 'SKILL.md'), 'utf8');
  assert.ok(!text.includes('2,000,000'), 'the old raw default is gone');
  for (const needle of ['--max-tokens', '1,500,000', 'weighted', 'cache reads count 0.1', '--budget', 'subscription', 'API billing']) assert.ok(text.includes(needle), `skill must mention ${needle}`);
});

test('formatReport: no --max-budget-usd in the commands without a budget (undefined or null), no <budget> placeholder', () => {
  const ok = fullArm();
  for (const budgetUsd of [undefined, null]) {
    const md = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: ok, without: ok }, budgetUsd, maxTokens: 1000 });
    assert.ok(!md.includes('--max-budget-usd'), String(budgetUsd));
    assert.ok(!md.includes('<budget>'));
  }
});

test('tokenCapNotEnforced / formatReport: a finished stream that counts the cap without a stop gets a WARNING banner', () => {
  const arm = fullArm(); // raw 18 + 150 + 4500 + 300 = 4968; weighted 18 + 150 + 300 + 450 = 918
  assert.equal(totalTokens(arm), 4968);
  assert.equal(weightedTokens(arm), 918);
  assert.equal(tokenCapNotEnforced(arm, 918), true);
  assert.equal(tokenCapNotEnforced(arm, 919), false, 'the cap is checked against weighted tokens, not raw');
  assert.equal(tokenCapNotEnforced({ ...arm, stoppedAtTokenCap: true }, 100), false, 'a stopped arm is not a surprise');
  assert.equal(tokenCapNotEnforced(arm, undefined), false);
  const md = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: arm, without: arm }, maxTokens: 100, warnings: ['the with arm: token cap reached but the arm was not stopped (918 weighted tokens counted, cap 100)'] });
  assert.ok(md.startsWith('**WARNING: the with arm: token cap reached but the arm was not stopped'), md.slice(0, 120));
});

test('formatReport: with --setup the safety paragraph and notes say the setup is outside the allowed-tools list', () => {
  const ok = fullArm();
  const md = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: ok, without: ok }, budgetUsd: 3, setup: { command: 'npm ci', note: 'ok (with 1.0 s, without 1.0 s)' } });
  assert.ok(md.includes('outside the allowed-tools list (package lifecycle scripts run), and is killed after --timeout-min'));
  assert.ok(md.includes('an arm edit to a file the setup also changed is not listed either'));
  const none = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: ok, without: ok }, budgetUsd: 3 });
  assert.ok(!none.includes('--setup command runs'));
});

test('measure skill: the run line has optional caps, a capped arm is called partial, and the setup limits are stated', () => {
  const text = readFileSync(path.join(here, '..', 'skills', 'measure', 'SKILL.md'), 'utf8');
  for (const needle of ['[--max-tokens <n>] [--budget <usd>]', 'is partial', 'outside the allowed-tools list', 'killed after `--timeout-min`']) assert.ok(text.includes(needle), needle);
});

// a stream shaped like the real one: one message id repeated on one line per content block, each line carrying the
// message_start usage (output_tokens 3), thinking_tokens events (cumulative per block, with a delta), timestamps, no result line
const tsLine = (type, ts, extra) => JSON.stringify({ type, timestamp: ts, ...extra });
const realUsage = { input_tokens: 4, output_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 };
const thinkEvent = (estimated, delta) => JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: estimated, estimated_tokens_delta: delta });
const blockLine = (id, ts, block) => tsLine('assistant', ts, { message: { id, usage: realUsage, content: [block] } });
const realShaped = [
  JSON.stringify({ type: 'system', subtype: 'init', plugins: [] }),
  thinkEvent(50, 50),
  thinkEvent(201, 151),
  blockLine('msg_A', '2026-10-31T08:00:00.000Z', { type: 'thinking', thinking: '', signature: '' }),
  blockLine('msg_A', '2026-10-31T08:00:01.000Z', { type: 'text', text: 'x'.repeat(40) }),
  blockLine('msg_A', '2026-10-31T08:00:01.000Z', { type: 'text', text: 'x'.repeat(40) }), // the same line twice: counted once
  blockLine('msg_A', '2026-10-31T08:00:02.000Z', { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } }), // input JSON is 16 chars
  tsLine('user', '2026-10-31T08:00:03.000Z', { message: { role: 'user', content: [] } }),
  thinkEvent(30, 30),
  blockLine('msg_B', '2026-10-31T08:03:20.500Z', { type: 'text', text: 'y'.repeat(20) }),
].join('\n');

test('parseStream without a result line: output tokens are estimated from text, tool inputs and thinking events (never the message_start 3)', () => {
  const r = parseStream(realShaped);
  // msg_A: (40 + 16) / 4 = 14; msg_B: 20 / 4 = 5; thinking: 50 + 151 + 30 = 231 (the sum of the deltas, not the cumulative values)
  assert.equal(r.tokens.output, 14 + 5 + 231);
  assert.equal(r.outputEstimated, true);
  assert.equal(r.tokens.input, 8);
  assert.equal(r.tokens.cacheRead, 4000);
  assert.equal(r.tokens.cacheWrite, 200);
  assert.equal(r.turns, 2);
  assert.equal(r.subtype, null);
});

test('parseStream: a message whose real usage is larger than the estimate keeps the usage; the result line usage replaces the estimate', () => {
  const big = [JSON.stringify({ type: 'assistant', message: { id: 'm', usage: { output_tokens: 500 }, content: [{ type: 'text', text: 'hi' }] } })].join('\n');
  assert.equal(parseStream(big).tokens.output, 500);
  const withResult = `${realShaped}\n${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 5000, usage: { output_tokens: 999 } })}`;
  const r = parseStream(withResult);
  assert.equal(r.tokens.output, 999);
  assert.equal(r.outputEstimated, false);
  assert.equal(r.tokens.cacheRead, 4000, 'the other counts still come from the messages');
  assert.equal(r.ms, 5000);
  assert.equal(r.msFromStream, false, 'the result line wins over the timestamps');
  const noUsage = `${realShaped}\n${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 5000 })}`;
  assert.equal(parseStream(noUsage).outputEstimated, true, 'a result line without usage leaves the estimate in place');
});

test('parseStream without a result line: time is the last minus the first timestamp in the stream', () => {
  const r = parseStream(realShaped);
  assert.equal(r.ms, 200500);
  assert.equal(r.msFromStream, true);
  assert.equal(parseStream(blockLine('m', '2026-10-31T08:00:00.000Z', { type: 'text', text: 'a' })).ms, null, 'one timestamp is no duration');
  assert.equal(parseStream(tsLine('user', 'not a date', {})).ms, null);
});

test('createTokenCounter: counts the estimated output and thinking like parseStream, so the cap and the report agree', () => {
  const c = createTokenCounter();
  c.feed(realShaped.slice(0, 200));
  const total = c.feed(`${realShaped.slice(200)}\n`);
  const parsed = parseStream(realShaped);
  assert.equal(total, weightedTokens(parsed));
  assert.equal(c.raw(), rawTokens(parsed));
  assert.equal(c.weighted(), 8 + 250 + 200 + 400);
  assert.equal(c.raw(), 8 + 250 + 200 + 4000);
});

test('formatReport: estimated output and stream-timestamp time are labelled; real ones are not', () => {
  const est = parseStream(realShaped);
  const md = formatReport({ date: 'd', task: 't', prompt: 'p', model: 'm', arms: { with: { ...est, exit: null }, without: fullArm() }, maxTokens: 1500000 });
  assert.ok(md.includes('| output tokens | 250 (estimated) | 150 |'), md);
  assert.ok(md.includes('| time | 200.5 s (from stream timestamps) | 61.0 s |'), md);
  assert.ok(md.includes('| tokens (weighted: cache reads at 0.1) | 858 | 918 |'), md);
  assert.ok(md.includes('| tokens (raw) | 4458 | 4968 |'), md);
  assert.ok(md.includes('weighted tokens (input + output + cache creation + 0.1 x cache read, rounded down)'), 'the note explains the cap');
  assert.ok(md.includes('Output is estimated while the arm runs'), 'the note says output is estimated');
});

test('weightedTokens / rawTokens: integer arithmetic, cache reads at a tenth, rounded down', () => {
  const t = (o) => ({ tokens: { output: 0, cacheRead: 0, cacheWrite: 0, input: 0, ...o } });
  assert.equal(weightedTokens(t({ cacheRead: 9 })), 0);
  assert.equal(weightedTokens(t({ cacheRead: 19, input: 1 })), 2);
  assert.equal(weightedTokens(t({ cacheRead: 1_958_770, input: 10, output: 400 })), 195_877 + 410);
  assert.equal(rawTokens(t({ cacheRead: 5, output: 1 })), 6);
  assert.equal(weightedTokens(undefined), 0);
});

test('README and CHANGELOG explain the weighting and the version is 0.2.2 everywhere', () => {
  const root = path.join(here, '..');
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /Version 0\.2\.2:/);
  assert.ok(readme.includes('cache reads count 0.1'), 'README explains the weighting');
  assert.ok(readme.includes('1,500,000'));
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## 0\.2\.2 /m);
  assert.equal(JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version, '0.2.2');
});
