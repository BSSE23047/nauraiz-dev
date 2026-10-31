// Pure helpers for the measure harness: read a `claude -p --output-format stream-json` stream,
// build the argument list for each arm, and format the markdown report. No I/O in this file.

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const PLUGIN_ID = 'nauraiz-dev@nauraiz-dev';
export const PLUGIN_NAME = 'nauraiz-dev';
export const PUSH_DISABLED = 'DISABLED-by-nauraiz-measure';
export const PERMISSION_MODE = 'acceptEdits';
export const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)', 'Bash(yarn *)', 'Bash(node *)', 'Bash(git status*)', 'Bash(git diff*)',
  'Bash(git log*)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git branch*)', 'Bash(git switch *)',
  'Bash(git checkout *)', 'Bash(git fetch*)', 'Bash(git rev-list *)', 'Bash(git ls-remote *)', 'Bash(gh issue view *)',
  'Bash(gh pr list *)', 'Bash(gh search *)',
  // the plugin runs its own process through these (a denied Skill call under `claude -p` stops it); both arms get them
  'Skill', 'Agent', 'AskUserQuestion', 'TodoWrite',
].join(' ');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// a negative field (nonsense) counts as 0: it must never lower the count the cap is checked against
const nonNeg = (v) => Math.max(0, num(v));

/** input + output + cache creation + cache read tokens of a parsed arm (parseStream's `tokens`): the raw count. */
export const rawTokens = (a) => num(a?.tokens?.input) + num(a?.tokens?.output) + num(a?.tokens?.cacheRead) + num(a?.tokens?.cacheWrite);

/** input + output + cache creation + 0.1 x cache read (subscription and API limits weight cache reads at about a tenth), rounded down: the count the token cap is checked against. Integer arithmetic, so no float drift. */
export const weightedTokens = (a) => Math.floor((10 * (num(a?.tokens?.input) + num(a?.tokens?.output) + num(a?.tokens?.cacheWrite)) + num(a?.tokens?.cacheRead)) / 10);

/**
 * Token bookkeeping shared by parseStream and the incremental counter, so the report and the cap agree.
 * Usage is kept once per assistant message id (a repeated id replaces the earlier usage). Output tokens
 * are not in the stream until the final result line: every assistant line carries the message_start value
 * (3). So per message the output is the larger of that value and an estimate (characters of the text blocks
 * plus the JSON length of the tool_use inputs, divided by 4, rounded up; each distinct block counted once),
 * plus the sum of the `estimated_tokens_delta` of the `system:thinking_tokens` events. A result line's own
 * usage replaces the estimate when it is present (see `tokens`).
 */
function createTally() {
  const usageById = new Map();
  const charsById = new Map();
  const seenBlocks = new Set();
  let thinking = 0;
  return {
    messages: () => usageById.size,
    addThinking(obj) { thinking += nonNeg(obj.estimated_tokens_delta); },
    addMessage(msg) {
      if (typeof msg.id !== 'string') return;
      if (msg.usage && typeof msg.usage === 'object') usageById.set(msg.id, msg.usage);
      else if (!usageById.has(msg.id)) usageById.set(msg.id, {});
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (!block || typeof block !== 'object') continue;
        let chars;
        if (block.type === 'text' && typeof block.text === 'string') chars = block.text.length;
        else if (block.type === 'tool_use') chars = JSON.stringify(block.input ?? {}).length;
        else continue;
        const key = `${msg.id}|${JSON.stringify(block)}`;
        if (seenBlocks.has(key)) continue;
        seenBlocks.add(key);
        charsById.set(msg.id, (charsById.get(msg.id) ?? 0) + chars);
      }
    },
    /** { tokens, outputEstimated }; `resultOutput` is the result line's output_tokens when it has one. */
    tokens(resultOutput) {
      const t = { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 };
      for (const [id, u] of usageById) {
        t.output += Math.max(nonNeg(u.output_tokens), Math.ceil((charsById.get(id) ?? 0) / 4));
        t.cacheRead += nonNeg(u.cache_read_input_tokens);
        t.cacheWrite += nonNeg(u.cache_creation_input_tokens);
        t.input += nonNeg(u.input_tokens);
      }
      const hasResult = typeof resultOutput === 'number' && Number.isFinite(resultOutput) && resultOutput >= 0;
      if (hasResult) t.output = resultOutput;
      else t.output += thinking;
      return { tokens: t, outputEstimated: !hasResult && (usageById.size > 0 || thinking > 0) };
    },
  };
}

/** Feed one parsed stream object into a tally (assistant messages and thinking events only). */
function tallyObject(tally, obj) {
  if (obj.type === 'system' && obj.subtype === 'thinking_tokens') tally.addThinking(obj);
  else if (obj.type === 'assistant' && obj.message && typeof obj.message === 'object') tally.addMessage(obj.message);
}

/**
 * An incremental token counter for the harness's token cap. `feed(chunk)` takes the next piece of the
 * stream-json stdout (any split, even mid-line) and returns the running weighted total, the number the cap
 * is checked against (`raw()` and `weighted()` give both; `total()` is the weighted one). It counts like
 * `parseStream` does for a stream without a result line (same tally, output estimated), and only complete
 * lines: a trailing fragment waits for its newline, except that a fragment which is already a complete JSON
 * object is counted at once, so the cap trips earlier, never later.
 */
export function createTokenCounter() {
  const tally = createTally();
  let pending = '';
  const take = (raw) => {
    const line = raw.trim();
    if (!line) return true;
    let obj;
    try { obj = JSON.parse(line); } catch { return false; }
    if (obj && typeof obj === 'object') tallyObject(tally, obj);
    return true;
  };
  const snapshot = () => ({ tokens: tally.tokens().tokens });
  return {
    feed(chunk) {
      pending += String(chunk ?? '');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const l of lines) take(l);
      if (pending && take(pending)) pending = '';
      return weightedTokens(snapshot());
    },
    raw: () => rawTokens(snapshot()),
    weighted: () => weightedTokens(snapshot()),
    total: () => weightedTokens(snapshot()),
  };
}

/**
 * Parse the text of a stream-json run. Invalid JSON lines and unknown line types are skipped.
 * Token usage is counted once per assistant message id (the stream repeats a message's usage on
 * every content block); a tool_use block is counted once per tool_use id.
 * `edits` are the raw tool-use paths (the report uses the clone's real changes instead);
 * `subtype`/`isError` come from the result line; `pluginCopies` counts nauraiz-dev entries in the init line.
 * Output tokens come from the result line's usage when it has one; otherwise they are estimated (see
 * `createTally`) and `outputEstimated` is true. `ms` is the result line's duration, else the last minus the
 * first `timestamp` in the stream (`msFromStream` true), else null.
 */
export function parseStream(text) {
  const tally = createTally();
  const seenToolUse = new Set();
  const skills = [];
  const edits = [];
  let questions = 0;
  let result = null;
  let pluginCopies = 0;
  let firstTs = Infinity;
  let lastTs = -Infinity;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    if (typeof obj.timestamp === 'string') {
      const t = Date.parse(obj.timestamp);
      if (Number.isFinite(t)) { firstTs = Math.min(firstTs, t); lastTs = Math.max(lastTs, t); }
    }
    tallyObject(tally, obj);
    if (obj.type === 'result') { result = obj; continue; }
    if (obj.type === 'system' && obj.subtype === 'init') {
      pluginCopies = (Array.isArray(obj.plugins) ? obj.plugins : []).filter((p) => p?.name === PLUGIN_NAME).length;
      continue;
    }
    if (obj.type !== 'assistant' || !obj.message || typeof obj.message !== 'object') continue;

    const msg = obj.message;

    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (!block || block.type !== 'tool_use') continue;
      if (typeof block.id === 'string') {
        if (seenToolUse.has(block.id)) continue;
        seenToolUse.add(block.id);
      }
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      if (block.name === 'Skill' && typeof input.skill === 'string' && !skills.includes(input.skill)) skills.push(input.skill);
      else if (block.name === 'AskUserQuestion') questions++;
      else if (EDIT_TOOLS.has(block.name)) {
        const file = input.file_path ?? input.notebook_path;
        if (typeof file === 'string' && file && !edits.includes(file)) edits.push(file);
      }
    }
  }

  const resultOutput = result?.usage && typeof result.usage === 'object' ? result.usage.output_tokens : undefined;
  const { tokens, outputEstimated } = tally.tokens(resultOutput);
  const resultMs = typeof result?.duration_ms === 'number' ? result.duration_ms : null;
  const streamMs = lastTs > firstTs ? lastTs - firstTs : null;

  return {
    ms: resultMs ?? streamMs,
    msFromStream: resultMs === null && streamMs !== null,
    costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
    tokens,
    outputEstimated,
    skills,
    questions,
    edits,
    turns: typeof result?.num_turns === 'number' ? result.num_turns : tally.messages(),
    subtype: typeof result?.subtype === 'string' ? result.subtype : null,
    isError: result?.is_error === true,
    pluginCopies,
  };
}

/** Same as `rawTokens`; kept for callers that ask for "the total". */
export const totalTokens = rawTokens;

/** True when the finished stream counts `maxTokens` weighted tokens or more but the harness did not stop the arm at the cap. */
export const tokenCapNotEnforced = (a, maxTokens) => Boolean(maxTokens) && !a?.stoppedAtTokenCap && weightedTokens(a) >= maxTokens;

/** The --settings content for both arms: the plugin installed under its marketplace id is switched off. */
export function settingsJson() {
  return JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } });
}

/**
 * The `claude` arguments for one arm. The prompt is NOT in argv: it goes on stdin. Both arms share every
 * flag; `with` adds `--plugin-dir`. `settingsFile` is a path to a file holding `settingsJson()`, so that
 * only the --plugin-dir copy of the plugin can load in the `with` arm and none in the `without` arm.
 */
export function buildArgs({ arm, model, budgetUsd, pluginDir, settingsFile, allowedTools = DEFAULT_ALLOWED_TOOLS }) {
  if (arm !== 'with' && arm !== 'without') throw new Error(`arm must be "with" or "without", got ${arm}`);
  const args = [
    '-p', '--model', model, '--output-format', 'stream-json', '--verbose',
  ];
  // no budget (token cap only): no --max-budget-usd at all
  if (budgetUsd !== undefined && budgetUsd !== null) args.push('--max-budget-usd', String(budgetUsd));
  args.push('--permission-mode', PERMISSION_MODE, '--allowedTools', allowedTools);
  if (settingsFile) args.push('--settings', settingsFile);
  if (arm === 'with') args.push('--plugin-dir', pluginDir);
  return args;
}

const shellQuote = (s) => (/^[\w@%+=:,./\\<>-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const list = (a) => (a.length ? a.join(', ') : 'none');
const capsText = (maxTokens, budgetUsd) => {
  const parts = [];
  if (maxTokens) parts.push(` Token cap: ${maxTokens} weighted tokens per arm (cache reads count 0.1).`);
  if (maxTokens && typeof budgetUsd === 'number') parts.push(` Budget cap: ${budgetUsd} USD per arm.`);
  return parts.join('');
};
const orNa = (v, f) => (v === null || v === undefined ? 'n/a' : f(v));

function gateCell(g) {
  if (!g) return 'not run';
  if (g.ok) return 'pass';
  const failed = (g.results ?? []).filter((r) => r.status === 'fail').map((r) => `${r.name}: ${r.why || 'failed'}`);
  return failed.length ? `fail (${failed.join('; ')})` : 'fail';
}

function resultCell(a) {
  if (a.stoppedAtTokenCap && a.subtype === null) return 'FAILED: stopped at the token cap';
  if (a.timedOut) return `FAILED: killed after the ${a.timedOut} min timeout`;
  if (a.subtype === null) return 'FAILED: no result line in the stream';
  return a.subtype === 'success' && !a.isError ? 'success' : `FAILED: ${a.subtype}${a.isError ? ' (is_error)' : ''}`;
}

/**
 * Markdown report: a table of every parsed field per arm, the gate result, the exact commands, the
 * safety settings and the n=1 disclaimer. An arm object is `parseStream`'s result plus optional
 * `files` (changed files read from the clone), `approvals` (count), `timedOut` (minutes) and `exit`
 * (claude's exit code). `failed` (a reason) puts a FAILED banner on top. Paths are placeholders
 * (`<plugin-dir>`, `<settings-file>`) so a report carries no local path.
 */
export function formatReport({ date, task, prompt, model, arms, gate = {}, budgetUsd, maxTokens, setup, allowedTools = DEFAULT_ALLOWED_TOOLS, failed, warnings = [] }) {
  const rows = [
    ['result', resultCell],
    ['time', (a) => orNa(a.ms, (v) => `${(v / 1000).toFixed(1)} s${a.msFromStream ? ' (from stream timestamps)' : ''}`)],
    ['cost (USD)', (a) => orNa(a.costUsd, (v) => v.toFixed(4))],
    ['output tokens', (a) => `${a.tokens.output}${a.outputEstimated ? ' (estimated)' : ''}`],
    ['cache read tokens', (a) => a.tokens.cacheRead],
    ['cache write tokens', (a) => a.tokens.cacheWrite],
    ['input tokens', (a) => a.tokens.input],
    ['tokens (weighted: cache reads at 0.1)', (a) => weightedTokens(a)],
    ['tokens (raw)', (a) => rawTokens(a)],
    ['turns', (a) => a.turns],
    ['stopped at token cap', (a) => (a.stoppedAtTokenCap ? 'yes' : 'no')],
    ['questions (AskUserQuestion calls only)', (a) => a.questions],
    ['skills invoked', (a) => list(a.skills)],
    ['nauraiz-dev copies loaded', (a) => a.pluginCopies ?? 'n/a'],
    ['files touched', (a) => list(a.files ?? [])],
    ['approvals recorded', (a) => a.approvals ?? 'n/a'],
  ];
  const out = [];
  if (failed) out.push(`**FAILED: ${failed}. The numbers below are incomplete.**`, '');
  for (const w of warnings) out.push(`**WARNING: ${w}.**`, '');
  out.push(
    `# Measure: ${task}`,
    '',
    `Date: ${date}. Model: ${model}.${capsText(maxTokens, budgetUsd)}`,
    ...(setup ? ['', `Setup ('${setup.command}', run in each clone before claude; its time and output are not part of the numbers): ${setup.note}.`] : []),
    '',
    'Prompt (identical for both arms, passed on stdin):',
    '',
    ...String(prompt).split(/\r?\n/).map((l) => `> ${l}`),
    '',
    '| metric | with | without |',
    '| --- | --- | --- |',
  );
  for (const [name, fn] of rows) out.push(`| ${name} | ${cell(fn(arms.with))} | ${cell(fn(arms.without))} |`);
  out.push(`| gate | ${cell(gateCell(gate.with))} | ${cell(gateCell(gate.without))} |`);
  out.push(`| claude exit code | ${arms.with.exit ?? 'n/a'} | ${arms.without.exit ?? 'n/a'} |`);
  out.push('', [
    'The questions row counts AskUserQuestion calls only: headless runs write their questions as decisions in the answer text, and those are not counted.',
    "Under `claude -p` a PreToolUse `ask` from a hook is treated as a deny: the edit is refused with the hook's reason and listed in the result's permission denials (probed on Claude Code 2.1.314).",
    'Files touched are read from each clone after the run (committed, modified and untracked, repo-relative).',
    ...(setup ? ['Files the setup created or changed are not listed under files touched, so an arm edit to a file the setup also changed is not listed either.'] : []),
    ...(maxTokens ? [`The token cap is enforced by the harness, not by a claude flag: it counts weighted tokens (input + output + cache creation + 0.1 x cache read, rounded down) per assistant message from the stream and kills the arm once the count reaches ${maxTokens}. Output is estimated while the arm runs, because the stream carries real output totals only in the result line (the characters of the text and tool inputs divided by 4, plus the thinking-token events). A message can overshoot the cap, and the arm keeps its partial stream.`] : []),
  ].join(' '));

  const common = { model, budgetUsd, pluginDir: '<plugin-dir>', settingsFile: '<settings-file>', allowedTools };
  const cmd = (arm) => `claude ${buildArgs({ arm, ...common }).map(shellQuote).join(' ')} < <prompt-file>`;
  out.push(
    '', 'Commands (each arm runs once in its own fresh clone of the same ref):', '', '```sh', cmd('with'), cmd('without'), '```',
    '', `Both arms: \`--settings\` file contents \`${settingsJson()}\` (the installed copy is off; the \`with\` arm loads the plugin only through \`--plugin-dir\`).`,
    '', `Safety, identical for both arms: \`--permission-mode ${PERMISSION_MODE}\`; allowed tools: \`${allowedTools}\`; pushing is disabled in each clone with \`git remote set-url --push origin ${PUSH_DISABLED}\` (the fetch URL stays so \`gh\` works). Only the disabled push URL is enforced; every other "no writes" rule rests on the allowed-tools list by convention, and \`node\` and \`npm\` can run anything.${setup ? ` The --setup command runs in each clone with the full environment, outside the allowed-tools list (package lifecycle scripts run), and is killed after --timeout-min.` : ''}`,
  );
  out.push('', 'n=1 per arm; not a benchmark.', '');
  return out.join('\n');
}
