#!/usr/bin/env node
// measure: run the same prompt twice through `claude -p`, once with this plugin and once without,
// each in its own fresh clone, and write a markdown report plus the two raw streams.
// One run per arm, each capped by --max-budget-usd. The runs cost money: never start one by accident.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/main.mjs';
import { findRecordedApprovals } from '../lib/decide-edit.mjs';
import { runGate } from '../gate/run.mjs';
import { DEFAULT_ALLOWED_TOOLS, PUSH_DISABLED, buildArgs, formatReport, parseStream, settingsJson } from './parse.mjs';

const ARMS = ['with', 'without'];
const LOCAL_CONFIG_REL = '.claude/nauraiz-dev.local.json';
const DEFAULT_PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_BUDGET_WITHOUT_FLAG = 20;
const DEFAULT_TIMEOUT_MIN = 30;

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * The `claude` executable: the first directly runnable file on PATH. On win32 that is `claude.exe`,
 * else `claude.cmd`; elsewhere `claude`. Falls back to the bare name so the spawn error names it.
 */
export function resolveClaude({ env = process.env, platform = process.platform, exists = isFile } = {}) {
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return 'claude';
}

/**
 * How to spawn `command args`. A win32 `.cmd`/`.bat` shim cannot be spawned without a shell, so it goes
 * through `shell: true` with every part double-quoted (safe because no user text is in argv: the prompt
 * is on stdin and the rest are paths, model names and tool lists). Anything else: `shell: false`.
 */
export function spawnSpec(command, args, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const quote = (part) => {
      if (/["%\r\n]/.test(part)) throw new Error(`cannot pass ${JSON.stringify(part)} through cmd.exe safely`);
      return `"${part}"`;
    };
    return { command: quote(command), args: args.map(quote), shell: true };
  }
  return { command, args, shell: false };
}

/** Run git without a shell. Returns stdout; throws with git's own message on a non-zero exit. */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(r.error?.message ?? r.stderr ?? '').trim()}`);
  }
  return r.stdout;
}

const gitOrEmpty = (args, cwd) => { try { return git(args, cwd); } catch { return ''; } };
const splitZ = (text) => text.split('\0').filter(Boolean);

/** Repo-relative files the arm changed: tracked changes against `ref` plus untracked (not ignored) files. */
export function changedFiles(cwd, ref, exclude = []) {
  const quiet = ['-c', 'core.quotepath=off'];
  const tracked = splitZ(gitOrEmpty([...quiet, 'diff', '--name-only', '-z', ref], cwd));
  const untracked = splitZ(gitOrEmpty([...quiet, 'ls-files', '--others', '--exclude-standard', '-z'], cwd));
  return [...new Set([...tracked, ...untracked])].filter((f) => !exclude.includes(f)).sort();
}

function walkMarkdown(dir, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMarkdown(p, depth + 1));
    else if (/\.md$/i.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Distinct recorded (non-pending) `*_approval` values the arm added: in its changed `.md` files and in any
 * `.md` under `.work/` (plans are usually git-ignored there). A value already present at `ref` does not count.
 */
export function countApprovals(cwd, ref, files) {
  const candidates = new Set(files.filter((f) => /\.md$/i.test(f)).map((f) => path.join(cwd, f)));
  for (const f of walkMarkdown(path.join(cwd, '.work'))) candidates.add(f);
  const added = new Set();
  for (const abs of candidates) {
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    const known = new Set(findRecordedApprovals(gitOrEmpty(['show', `${ref}:${rel}`], cwd)));
    for (const v of findRecordedApprovals(text)) if (!known.has(v)) added.add(v);
  }
  return added.size;
}

function killTree(child, platform) {
  try { child.kill(); } catch { /* already gone */ }
  if (platform === 'win32' && child.pid) {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

/**
 * Run one arm (prompt on stdin). Resolves { code, stdout, timedOut, spawnError }; `spawnError` is set when
 * `claude` could not be started at all (not found, not executable, spawn threw).
 */
function runClaude({ spawn, command, args, cwd, input, timeoutMs, platform }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    let timer;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ stdout, timedOut, ...r }); } };
    let child;
    try {
      const spec = spawnSpec(command, args, platform);
      child = spawn(spec.command, spec.args, { cwd, shell: spec.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ code: null, spawnError: String(e.message) });
      return;
    }
    timer = setTimeout(() => { timedOut = true; killTree(child, platform); }, timeoutMs);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.stdin?.on?.('error', () => {});
    child.stdin?.end?.(input);
    child.on('error', (e) => finish({ code: null, spawnError: String(e.message) }));
    child.on('close', (code) => finish({ code: code ?? null, spawnError: null, stderr }));
  });
}

/** Words from the git-ignored `.forbidden-terms` in the plugin root (same file tests/forbidden.mjs reads). */
export function readForbiddenTerms(pluginDir) {
  try {
    return readFileSync(path.join(pluginDir, '.forbidden-terms'), 'utf8').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Look for private material in the written files: the home dir, the OS temp root, the real plugin dir
 * (each in raw, doubled-backslash and forward-slash spelling, case-insensitively) and the forbidden terms
 * (as whole words). Returns [{ file, label }]; never the forbidden term itself.
 */
export function scanLeaks({ files, pluginDir, tmpRoot, home = homedir() }) {
  const spellings = (v) => (v ? [...new Set([v, v.replace(/\\/g, '\\\\'), v.replace(/\\/g, '/')])].map((x) => x.toLowerCase()) : []);
  const needles = [
    { label: 'home directory', values: spellings(home) },
    { label: 'OS temp directory', values: spellings(tmpRoot) },
    { label: 'plugin directory', values: spellings(pluginDir) },
  ];
  const terms = readForbiddenTerms(pluginDir);
  const termRe = terms.length ? new RegExp(`\\b(?:${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i') : null;
  const hits = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const lower = text.toLowerCase();
    for (const { label, values } of needles) if (values.some((v) => lower.includes(v))) hits.push({ file, label });
    if (termRe && termRe.test(text)) hits.push({ file, label: 'forbidden term (see .forbidden-terms)' });
  }
  return hits;
}

/**
 * Run both arms and write `<out>`, `<out>.with.jsonl`, `<out>.without.jsonl`.
 * Refuses (before touching anything) unless `budgetUsd` is a positive number (above 20 only with
 * `allowHighBudget`). The approximate total cap is 2 x budget. `spawn` and `gateExec` are injectable so
 * tests never start `claude`. If `claude` cannot be started the run stops, the report is marked FAILED
 * and `ok` is false. The prompt goes on stdin; both arms get a --settings file switching the installed
 * copy of this plugin off, the same permission mode and tool list, and a clone that cannot push.
 */
export async function runMeasure({
  repo, ref, prompt, model = 'sonnet', budgetUsd, out, gate, localConfig, task, allowedTools = DEFAULT_ALLOWED_TOOLS,
  timeoutMin = DEFAULT_TIMEOUT_MIN, allowHighBudget = false,
  pluginDir = DEFAULT_PLUGIN_DIR, date = new Date().toISOString().slice(0, 10),
  spawn = nodeSpawn, gateExec, tmpRoot = tmpdir(), log = console.log, claude = resolveClaude(), platform = process.platform,
}) {
  const budget = typeof budgetUsd === 'number' ? budgetUsd : Number.NaN;
  if (!(budget > 0) || !Number.isFinite(budget)) {
    throw new Error('--budget <usd per arm> is required and must be greater than 0; refusing to run');
  }
  if (budget > MAX_BUDGET_WITHOUT_FLAG && !allowHighBudget) {
    throw new Error(`--budget ${budget} is above ${MAX_BUDGET_WITHOUT_FLAG} USD per arm; pass --allow-high-budget if that is intended`);
  }
  if (!(typeof timeoutMin === 'number' && timeoutMin > 0 && Number.isFinite(timeoutMin))) throw new Error('--timeout-min must be a positive number');
  for (const [name, value] of [['--repo', repo], ['--ref', ref], ['--out', out]]) {
    if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('the prompt is empty');
  if (ref.startsWith('-') || repo.startsWith('-')) throw new Error('--repo and --ref must not start with "-"');
  const localConfigText = localConfig ? readFileSync(localConfig, 'utf8') : null;
  if (localConfigText) JSON.parse(localConfigText); // refuse a broken config before spending anything

  const totalCapUsd = budget * ARMS.length;
  log(`Approximate total cap: ${totalCapUsd} USD (${ARMS.length} arms x ${budget} USD, --max-budget-usd per arm; the CLI may overshoot slightly). One run per arm.`);

  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const work = mkdtempSync(path.join(tmpRoot, 'nauraiz-measure-'));
  const settingsFile = path.join(work, 'settings.json');
  const arms = {};
  const gates = {};
  const written = [];
  let failed = null;
  try {
    writeFileSync(settingsFile, settingsJson());
    for (const arm of ARMS) {
      const cwd = path.join(work, arm);
      log(`[${arm}] cloning ${repo} at ${ref}`);
      git(['clone', '--no-hardlinks', repo, cwd]);
      git(['checkout', '--detach', ref], cwd);
      git(['remote', 'set-url', '--push', 'origin', PUSH_DISABLED], cwd);
      const exclude = [];
      if (arm === 'with' && localConfigText) {
        mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        writeFileSync(path.join(cwd, ...LOCAL_CONFIG_REL.split('/')), localConfigText);
        exclude.push(LOCAL_CONFIG_REL);
      }

      log(`[${arm}] running claude (cap ${budget} USD, timeout ${timeoutMin} min)`);
      const args = buildArgs({ arm, model, budgetUsd: budget, pluginDir, settingsFile, allowedTools });
      const run = await runClaude({ spawn, command: claude, args, cwd, input: prompt, timeoutMs: timeoutMin * 60_000, platform });
      if (run.spawnError) {
        failed = `claude could not be started for the ${arm} arm (${run.spawnError})`;
        arms[arm] = { ...parseStream(''), exit: null };
        log(`[${arm}] ${failed}`);
        break;
      }
      writeFileSync(`${out}.${arm}.jsonl`, run.stdout);
      written.push(`${out}.${arm}.jsonl`);
      if (run.code !== 0 && run.stderr?.trim()) log(`claude: ${run.stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}`);

      const files = changedFiles(cwd, ref, exclude);
      arms[arm] = {
        ...parseStream(run.stdout), exit: run.code, files, approvals: countApprovals(cwd, ref, files),
        timedOut: run.timedOut ? timeoutMin : false,
      };
      gates[arm] = null;
      if (gate) {
        const { ok, results } = await runGate({ cwd, config: { gate: { gate } }, exec: gateExec });
        gates[arm] = { ok, results };
      }
      log(`[${arm}] done: exit ${run.code ?? 'n/a'}${run.timedOut ? ' (timed out)' : ''}, cost ${arms[arm].costUsd ?? 'n/a'} USD`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  for (const arm of ARMS) arms[arm] ??= { ...parseStream(''), exit: null };

  const firstLine = prompt.trim().split(/\r?\n/)[0];
  const md = formatReport({
    date, task: task ?? (firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine), prompt: prompt.trim(), model,
    arms, gate: gates, budgetUsd: budget, allowedTools, failed,
  });
  writeFileSync(out, md);
  written.unshift(out);
  log(`Report: ${out}`);

  const leaks = scanLeaks({ files: written, pluginDir, tmpRoot });
  if (leaks.length) {
    log('WARNING: private material found in the output. Do NOT commit or publish these files before removing it:');
    for (const { file, label } of leaks) log(`WARNING:   ${file}: ${label}`);
  }
  return { reportPath: out, totalCapUsd, arms, gates, ok: failed === null, failed, leaks };
}

const BOOLEAN_FLAGS = new Set(['allow-high-budget']);

/** Parse the CLI flags into runMeasure options. Throws on a missing required flag or unreadable prompt file. */
export function parseCli(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (!flag.startsWith('--')) continue;
    const name = flag.slice(2);
    flags[name] = BOOLEAN_FLAGS.has(name) ? true : inline !== undefined ? inline : argv[++i];
  }
  for (const name of ['repo', 'ref', 'prompt-file', 'out']) {
    if (!flags[name]) throw new Error(`--${name} is required`);
  }
  let prompt;
  try { prompt = readFileSync(flags['prompt-file'], 'utf8').trim(); } catch (e) {
    throw new Error(`cannot read the prompt file: ${e.message}`);
  }
  const opts = {
    repo: flags.repo,
    ref: flags.ref,
    prompt,
    model: flags.model ?? 'sonnet',
    budgetUsd: flags.budget === undefined ? undefined : Number(flags.budget),
    out: flags.out,
    gate: flags.gate,
    localConfig: flags['local-config'],
    task: flags.task,
    allowHighBudget: flags['allow-high-budget'] === true,
  };
  if (flags['allowed-tools']) opts.allowedTools = flags['allowed-tools'];
  if (flags['timeout-min'] !== undefined) opts.timeoutMin = Number(flags['timeout-min']);
  return opts;
}

if (isMain(import.meta.url)) {
  let opts;
  try { opts = parseCli(process.argv.slice(2)); } catch (e) {
    console.error(`nauraiz-dev: ${e.message}`);
    process.exit(2);
  }
  runMeasure(opts).then((r) => {
    if (!r.ok) { console.error(`nauraiz-dev: FAILED: ${r.failed}`); process.exit(1); }
  }).catch((e) => {
    console.error(`nauraiz-dev: ${e.message}`);
    process.exit(/--budget|--timeout-min/.test(e.message) ? 2 : 1);
  });
}
