// Pure helpers for the measure harness: read a `claude -p --output-format stream-json` stream,
// build the argument list for each arm, and format the markdown report. No I/O in this file.

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const PLUGIN_ID = 'nauraiz-dev@nauraiz-dev';
export const PLUGIN_NAME = 'nauraiz-dev';
export const PUSH_DISABLED = 'DISABLED-by-nauraiz-measure';
export const PERMISSION_MODE = 'acceptEdits';
export const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(git status*)', 'Bash(git diff*)',
  'Bash(git log*)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git branch*)', 'Bash(git switch *)',
  'Bash(git checkout *)', 'Bash(git fetch*)', 'Bash(git rev-list *)', 'Bash(git ls-remote *)', 'Bash(gh issue view *)',
  'Bash(gh pr list *)', 'Bash(gh api user*)', 'Bash(gh search *)',
].join(' ');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Parse the text of a stream-json run. Invalid JSON lines and unknown line types are skipped.
 * Token usage is counted once per assistant message id (the stream repeats a message's usage on
 * every content block); a tool_use block is counted once per tool_use id.
 * `edits` are the raw tool-use paths (the report uses the clone's real changes instead);
 * `subtype`/`isError` come from the result line; `pluginCopies` counts nauraiz-dev entries in the init line.
 */
export function parseStream(text) {
  const usageById = new Map();
  const seenToolUse = new Set();
  const skills = [];
  const edits = [];
  let questions = 0;
  let result = null;
  let pluginCopies = 0;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    if (obj.type === 'result') { result = obj; continue; }
    if (obj.type === 'system' && obj.subtype === 'init') {
      pluginCopies = (Array.isArray(obj.plugins) ? obj.plugins : []).filter((p) => p?.name === PLUGIN_NAME).length;
      continue;
    }
    if (obj.type !== 'assistant' || !obj.message || typeof obj.message !== 'object') continue;

    const msg = obj.message;
    if (typeof msg.id === 'string' && msg.usage && typeof msg.usage === 'object') usageById.set(msg.id, msg.usage);
    else if (typeof msg.id === 'string' && !usageById.has(msg.id)) usageById.set(msg.id, {});

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

  const tokens = { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 };
  for (const u of usageById.values()) {
    tokens.output += num(u.output_tokens);
    tokens.cacheRead += num(u.cache_read_input_tokens);
    tokens.cacheWrite += num(u.cache_creation_input_tokens);
    tokens.input += num(u.input_tokens);
  }

  return {
    ms: typeof result?.duration_ms === 'number' ? result.duration_ms : null,
    costUsd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
    tokens,
    skills,
    questions,
    edits,
    turns: typeof result?.num_turns === 'number' ? result.num_turns : usageById.size,
    subtype: typeof result?.subtype === 'string' ? result.subtype : null,
    isError: result?.is_error === true,
    pluginCopies,
  };
}

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
    '-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--max-budget-usd', String(budgetUsd),
    '--permission-mode', PERMISSION_MODE, '--allowedTools', allowedTools,
  ];
  if (settingsFile) args.push('--settings', settingsFile);
  if (arm === 'with') args.push('--plugin-dir', pluginDir);
  return args;
}

const shellQuote = (s) => (/^[\w@%+=:,./\\<>-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const list = (a) => (a.length ? a.join(', ') : 'none');
const orNa = (v, f) => (v === null || v === undefined ? 'n/a' : f(v));

function gateCell(g) {
  if (!g) return 'not run';
  if (g.ok) return 'pass';
  const failed = (g.results ?? []).filter((r) => r.status === 'fail').map((r) => `${r.name}: ${r.why || 'failed'}`);
  return failed.length ? `fail (${failed.join('; ')})` : 'fail';
}

function resultCell(a) {
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
export function formatReport({ date, task, prompt, model, arms, gate = {}, budgetUsd, allowedTools = DEFAULT_ALLOWED_TOOLS, failed }) {
  const rows = [
    ['result', resultCell],
    ['time', (a) => orNa(a.ms, (v) => `${(v / 1000).toFixed(1)} s`)],
    ['cost (USD)', (a) => orNa(a.costUsd, (v) => v.toFixed(4))],
    ['output tokens', (a) => a.tokens.output],
    ['cache read tokens', (a) => a.tokens.cacheRead],
    ['cache write tokens', (a) => a.tokens.cacheWrite],
    ['input tokens', (a) => a.tokens.input],
    ['turns', (a) => a.turns],
    ['questions (AskUserQuestion calls only)', (a) => a.questions],
    ['skills invoked', (a) => list(a.skills)],
    ['nauraiz-dev copies loaded', (a) => a.pluginCopies ?? 'n/a'],
    ['files touched', (a) => list(a.files ?? [])],
    ['approvals recorded', (a) => a.approvals ?? 'n/a'],
  ];
  const out = [];
  if (failed) out.push(`**FAILED: ${failed}. The numbers below are incomplete.**`, '');
  out.push(
    `# Measure: ${task}`,
    '',
    `Date: ${date}. Model: ${model}.`,
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
  out.push('', 'Headless runs write their questions as decisions in the answer text; those are not counted in the questions row. Files touched are read from each clone after the run (committed, modified and untracked, repo-relative).');

  const common = { model, budgetUsd: budgetUsd ?? '<budget>', pluginDir: '<plugin-dir>', settingsFile: '<settings-file>', allowedTools };
  const cmd = (arm) => `claude ${buildArgs({ arm, ...common }).map(shellQuote).join(' ')} < <prompt-file>`;
  out.push(
    '', 'Commands (each arm runs once in its own fresh clone of the same ref):', '', '```sh', cmd('with'), cmd('without'), '```',
    '', `Both arms: \`--settings\` file contents \`${settingsJson()}\` (the installed copy is off; the \`with\` arm loads the plugin only through \`--plugin-dir\`).`,
    '', `Safety, identical for both arms: \`--permission-mode ${PERMISSION_MODE}\`; allowed tools: \`${allowedTools}\`; pushing is disabled in each clone with \`git remote set-url --push origin ${PUSH_DISABLED}\` (the fetch URL stays so \`gh\` works).`,
  );
  out.push('', 'n=1 per arm; not a benchmark.', '');
  return out.join('\n');
}
