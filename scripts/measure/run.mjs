#!/usr/bin/env node
// measure: run the same prompt twice through `claude -p`, once with this plugin and once without,
// each in its own fresh clone, and write a markdown report plus the two raw streams.
// One run per arm, each capped by --max-budget-usd. The runs cost money: never start one by accident.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/main.mjs';
import { runGate } from '../gate/run.mjs';
import { buildArgs, formatReport, parseStream } from './parse.mjs';

const ARMS = ['with', 'without'];
const LOCAL_CONFIG = path.join('.claude', 'nauraiz-dev.local.json');
const DEFAULT_PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/** Run git without a shell; throws with git's own message on a non-zero exit. */
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(r.error?.message ?? r.stderr ?? '').trim()}`);
  }
}

/** Run one arm through `spawn` (shell: false). Resolves { code, stdout }; a spawn failure gives code null. */
function runClaude({ spawn, command, args, cwd, log }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    const finish = (code) => {
      if (code !== 0 && stderr.trim()) log(`claude: ${stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}`);
      resolve({ code, stdout });
    };
    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      stderr = String(e.message);
      finish(null);
      return;
    }
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { stderr += String(e.message); finish(null); });
    child.on('close', (code) => finish(code ?? null));
  });
}

/**
 * Run both arms and write `<out>`, `<out>.with.jsonl`, `<out>.without.jsonl`.
 * Refuses (before touching anything) unless `budgetUsd` is a positive number; the total cap is 2 x budget.
 * `spawn` and `gateExec` are injectable so tests never start `claude`.
 */
export async function runMeasure({
  repo, ref, prompt, model = 'sonnet', budgetUsd, out, gate, localConfig, task,
  pluginDir = DEFAULT_PLUGIN_DIR, date = new Date().toISOString().slice(0, 10),
  spawn = nodeSpawn, gateExec, tmpRoot = tmpdir(), log = console.log, claude = resolveClaude(),
}) {
  const budget = typeof budgetUsd === 'number' ? budgetUsd : Number.NaN;
  if (!(budget > 0) || !Number.isFinite(budget)) {
    throw new Error('--budget <usd per arm> is required and must be greater than 0; refusing to run');
  }
  for (const [name, value] of [['--repo', repo], ['--ref', ref], ['--out', out]]) {
    if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('the prompt is empty');
  if (ref.startsWith('-') || repo.startsWith('-')) throw new Error('--repo and --ref must not start with "-"');
  const localConfigText = localConfig ? readFileSync(localConfig, 'utf8') : null;
  if (localConfigText) JSON.parse(localConfigText); // refuse a broken config before spending anything

  const totalCapUsd = budget * ARMS.length;
  log(`Total cap: ${totalCapUsd} USD (${ARMS.length} arms x ${budget} USD, --max-budget-usd per arm). One run per arm.`);

  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const work = mkdtempSync(path.join(tmpRoot, 'nauraiz-measure-'));
  const arms = {};
  const gates = {};
  const exits = {};
  try {
    for (const arm of ARMS) {
      const cwd = path.join(work, arm);
      log(`[${arm}] cloning ${repo} at ${ref}`);
      git(['clone', '--no-hardlinks', repo, cwd]);
      git(['checkout', ref], cwd);
      if (arm === 'with' && localConfigText) {
        mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        writeFileSync(path.join(cwd, LOCAL_CONFIG), localConfigText);
      }

      log(`[${arm}] running claude (cap ${budget} USD)`);
      const args = buildArgs({ arm, prompt, model, budgetUsd: budget, pluginDir });
      const { code, stdout } = await runClaude({ spawn, command: claude, args, cwd, log });
      writeFileSync(`${out}.${arm}.jsonl`, stdout);
      arms[arm] = parseStream(stdout);
      exits[arm] = code;

      gates[arm] = null;
      if (gate) {
        const { ok, results } = await runGate({ cwd, config: { gate: { gate } }, exec: gateExec });
        gates[arm] = { ok, results };
      }
      log(`[${arm}] done: exit ${code ?? 'n/a'}, cost ${arms[arm].costUsd ?? 'n/a'} USD`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const firstLine = prompt.trim().split(/\r?\n/)[0];
  const md = formatReport({
    date, task: task ?? (firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine), prompt: prompt.trim(), model,
    arms, gate: gates, budgetUsd: budget, pluginDir, exits,
  });
  writeFileSync(out, md);
  log(`Report: ${out}`);
  return { reportPath: out, totalCapUsd, arms, gates, exits };
}

/** Parse the CLI flags into runMeasure options. Throws on a missing required flag or unreadable prompt file. */
export function parseCli(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (!flag.startsWith('--')) continue;
    flags[flag.slice(2)] = inline !== undefined ? inline : argv[++i];
  }
  for (const name of ['repo', 'ref', 'prompt-file', 'out']) {
    if (!flags[name]) throw new Error(`--${name} is required`);
  }
  let prompt;
  try { prompt = readFileSync(flags['prompt-file'], 'utf8').trim(); } catch (e) {
    throw new Error(`cannot read the prompt file: ${e.message}`);
  }
  return {
    repo: flags.repo,
    ref: flags.ref,
    prompt,
    model: flags.model ?? 'sonnet',
    budgetUsd: flags.budget === undefined ? undefined : Number(flags.budget),
    out: flags.out,
    gate: flags.gate,
    localConfig: flags['local-config'],
    task: flags.task,
  };
}

if (isMain(import.meta.url)) {
  let opts;
  try { opts = parseCli(process.argv.slice(2)); } catch (e) {
    console.error(`nauraiz-dev: ${e.message}`);
    process.exit(2);
  }
  runMeasure(opts).catch((e) => {
    console.error(`nauraiz-dev: ${e.message}`);
    process.exit(/--budget/.test(e.message) ? 2 : 1);
  });
}
