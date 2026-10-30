// Pure helpers for the measure harness: read a `claude -p --output-format stream-json` stream,
// build the argument list for each arm, and format the markdown report. No I/O in this file.

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PLUGIN_ID = 'nauraiz-dev@nauraiz-dev';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Parse the text of a stream-json run. Invalid JSON lines and unknown line types are skipped.
 * Token usage is counted once per assistant message id (the stream repeats a message's usage on
 * every content block); a tool_use block is counted once per tool_use id.
 */
export function parseStream(text) {
  const usageById = new Map();
  const seenToolUse = new Set();
  const skills = [];
  const edits = [];
  let questions = 0;
  let result = null;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    if (obj.type === 'result') { result = obj; continue; }
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
  };
}

/** The `claude` arguments for one arm. `without` disables this plugin through an inline --settings JSON. */
export function buildArgs({ arm, prompt, model, budgetUsd, pluginDir }) {
  if (arm !== 'with' && arm !== 'without') throw new Error(`arm must be "with" or "without", got ${arm}`);
  const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--max-budget-usd', String(budgetUsd)];
  if (arm === 'with') args.push('--plugin-dir', pluginDir);
  else args.push('--settings', JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }));
  return args;
}

const shellQuote = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const list = (a) => (a.length ? a.join(', ') : 'none');
const orNa = (v, f) => (v === null || v === undefined ? 'n/a' : f(v));

function gateCell(g) {
  if (!g) return 'not run';
  if (g.ok) return 'pass';
  const failed = (g.results ?? []).filter((r) => r.status === 'fail').map((r) => `${r.name}: ${r.why || 'failed'}`);
  return failed.length ? `fail (${failed.join('; ')})` : 'fail';
}

/**
 * Markdown report: a table of every parsed field per arm, the gate result, the exact commands and the
 * n=1 disclaimer. `budgetUsd` and `pluginDir` (optional) make the printed commands exact; `exits`
 * (optional) adds the claude exit code per arm.
 */
export function formatReport({ date, task, prompt, model, arms, gate = {}, budgetUsd, pluginDir, exits }) {
  const rows = [
    ['time', (a) => orNa(a.ms, (v) => `${(v / 1000).toFixed(1)} s`)],
    ['cost (USD)', (a) => orNa(a.costUsd, (v) => v.toFixed(4))],
    ['output tokens', (a) => a.tokens.output],
    ['cache read tokens', (a) => a.tokens.cacheRead],
    ['cache write tokens', (a) => a.tokens.cacheWrite],
    ['input tokens', (a) => a.tokens.input],
    ['turns', (a) => a.turns],
    ['questions asked', (a) => a.questions],
    ['skills invoked', (a) => list(a.skills)],
    ['files touched', (a) => list(a.edits)],
  ];
  const out = [
    `# Measure: ${task}`,
    '',
    `Date: ${date}. Model: ${model}.`,
    '',
    'Prompt (identical for both arms):',
    '',
    ...String(prompt).split(/\r?\n/).map((l) => `> ${l}`),
    '',
    '| metric | with | without |',
    '| --- | --- | --- |',
  ];
  for (const [name, fn] of rows) out.push(`| ${name} | ${cell(fn(arms.with))} | ${cell(fn(arms.without))} |`);
  out.push(`| gate | ${cell(gateCell(gate.with))} | ${cell(gateCell(gate.without))} |`);
  if (exits) out.push(`| claude exit code | ${exits.with ?? 'n/a'} | ${exits.without ?? 'n/a'} |`);

  const cmd = (arm) => ['claude', ...buildArgs({ arm, prompt, model, budgetUsd: budgetUsd ?? '<budget>', pluginDir: pluginDir ?? '<plugin-dir>' }).map(shellQuote)].join(' ');
  out.push('', 'Commands (each arm runs in its own fresh clone of the same ref):', '', '```sh', cmd('with'), cmd('without'), '```');
  out.push('', 'n=1 per arm; not a benchmark.', '');
  return out.join('\n');
}
