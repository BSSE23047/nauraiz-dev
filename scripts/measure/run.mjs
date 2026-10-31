#!/usr/bin/env node
// measure: run the same prompt twice through `claude -p`, once with this plugin and once without,
// each in its own fresh clone, and write a markdown report plus the two raw streams.
// One run per arm, each capped by --max-tokens (counted here from the stream) and/or --max-budget-usd.
// The runs cost money or plan usage: never start one by accident.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/main.mjs';
import { findRecordedApprovals } from '../lib/decide-edit.mjs';
import { runGate } from '../gate/run.mjs';
import {
  DEFAULT_ALLOWED_TOOLS, PUSH_DISABLED, buildArgs, createTokenCounter, formatReport, parseStream, settingsJson, tokenCapNotEnforced, totalTokens,
} from './parse.mjs';

const ARMS = ['with', 'without'];
const LOCAL_CONFIG_REL = '.claude/nauraiz-dev.local.json';
const DEFAULT_PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_BUDGET_WITHOUT_FLAG = 20;
const MAX_TOKENS_WITHOUT_FLAG = 20_000_000;
const DEFAULT_TIMEOUT_MIN = 30;

/** A refusal caused by the arguments (exit 2), as opposed to a failure while running (exit 1). */
export class UsageError extends Error {}

/** The CLI exit code for an error thrown by parseCli/runMeasure. */
export const exitCodeFor = (err) => (err instanceof UsageError ? 2 : 1);

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
export function changedFiles(cwd, ref, exclude = new Set()) {
  const skip = new Set(exclude);
  const quiet = ['-c', 'core.quotepath=off'];
  const tracked = splitZ(gitOrEmpty([...quiet, 'diff', '--name-only', '-z', ref], cwd));
  const untracked = splitZ(gitOrEmpty([...quiet, 'ls-files', '--others', '--exclude-standard', '-z'], cwd));
  return [...new Set([...tracked, ...untracked])].filter((f) => !skip.has(f)).sort();
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

const GROUP_KILL_GRACE_MS = 2000;

/**
 * Stop a child and everything it started. win32: `taskkill /t /f`. POSIX: the child was spawned
 * `detached` (its own process group), so SIGTERM goes to the whole group and, if anything is still
 * there after a grace period, SIGKILL; a bare `sh -c` kill would leave grandchildren running (and
 * spending). A child without a pid (a test fake) only gets `child.kill()`. The tree kill comes first:
 * on win32 `taskkill /t` walks the tree from the child, so killing the child (`cmd.exe` for a shell
 * spawn) first would orphan its descendants, which then keep the pipes and the clone's folder busy.
 */
function killTree(child, platform) {
  const plainKill = () => { try { child.kill(); } catch { /* already gone */ } };
  if (!child.pid) { plainKill(); return; }
  if (platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    plainKill();
    return;
  }
  const signalGroup = (signal) => { try { process.kill(-child.pid, signal); } catch { /* group already gone */ } };
  signalGroup('SIGTERM');
  plainKill();
  setTimeout(() => signalGroup('SIGKILL'), GROUP_KILL_GRACE_MS);
}

/**
 * POSIX only: the detached child is in its own process group, so Ctrl-C on the harness would not reach
 * it. Until `dispose()`, an exit or SIGINT/SIGTERM of the harness SIGKILLs the child's group first.
 */
function guardGroup(child, platform) {
  if (platform === 'win32' || !child.pid) return () => {};
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
  const onSignal = (signal) => { kill(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  process.once('exit', kill);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => { process.off('exit', kill); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); };
}

/**
 * Default setup executor: run `command` through the shell in `cwd` (the way the gate runs its commands),
 * killed with the same tree-kill as an arm after `timeoutMs`. On timeout it resolves at once from the
 * timer (code 1, output so far, timedOut true) and does not wait for the pipes to close: a grandchild that
 * outlives the kill would otherwise hold them open. (win32: `taskkill /t` ends the whole tree, so it waits
 * for the close, which lets the clone's folder be released before it is deleted, with a 3 s fallback.) It inherits the full environment and is not limited by
 * the allowed-tools list. Resolves { code, output, timedOut }.
 */
export function shellSetupExec(command, cwd, timeoutMs, platform = process.platform) {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let done = false;
    let timer;
    let child;
    let forceTimer;
    let dispose = () => {};
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      dispose();
      resolve({ code, output, timedOut });
    };
    try {
      child = nodeSpawn(command, { cwd, shell: true, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      output = String(e.message);
      finish(1);
      return;
    }
    dispose = guardGroup(child, platform);
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child, platform);
      const giveUp = () => { child.stdout?.destroy?.(); child.stderr?.destroy?.(); finish(1); };
      if (platform === 'win32') forceTimer = setTimeout(giveUp, 3000);
      else giveUp();
    }, timeoutMs);
    const take = (chunk) => { output += chunk; };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);
    child.on('error', (e) => { output += String(e.message); finish(1); });
    child.on('close', (code) => finish(code ?? 1));
  });
}

const tailLines = (text, n = 3) => String(text ?? '').split(/\r?\n/).filter((l) => l.trim()).slice(-n).join(' | ');

/**
 * Run one arm (prompt on stdin). Resolves { code, stdout, timedOut, stoppedAtTokenCap, spawnError };
 * `spawnError` is set when `claude` could not be started at all (not found, not executable, spawn threw).
 * With `maxTokens` the stdout is counted as it streams and the child is killed (same kill path as the
 * timeout) once the count reaches it; the partial stdout is kept.
 */
function runClaude({ spawn, command, args, cwd, input, timeoutMs, platform, maxTokens, onTokenCap }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stoppedAtTokenCap = false;
    let done = false;
    let timer;
    const counter = maxTokens ? createTokenCounter() : null;
    let dispose = () => {};
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); dispose(); resolve({ stdout, timedOut, stoppedAtTokenCap, ...r }); } };
    let child;
    try {
      const spec = spawnSpec(command, args, platform);
      // POSIX: its own process group, so a kill reaches everything claude started
      child = spawn(spec.command, spec.args, { cwd, shell: spec.shell, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ code: null, spawnError: String(e.message) });
      return;
    }
    dispose = guardGroup(child, platform);
    timer = setTimeout(() => { timedOut = true; killTree(child, platform); }, timeoutMs);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (c) => {
      if (stoppedAtTokenCap) return; // the stream is cut at the chunk that reached the cap
      stdout += c;
      if (!counter || done) return;
      const total = counter.feed(c);
      if (total >= maxTokens) {
        stoppedAtTokenCap = true;
        onTokenCap?.(total);
        killTree(child, platform);
      }
    });
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
 * Refuses (before touching anything) unless at least one cap is given: `maxTokens` (a positive integer,
 * per arm; above 20,000,000 only with `allowHighBudget`) and/or `budgetUsd` (a positive number, per arm;
 * above 20 only with `allowHighBudget`). Both given: both apply. The approximate totals are 2 x each cap.
 * The token cap is enforced here: the arm's stdout is counted as it streams and the arm is killed (like
 * the timeout) when the count reaches it; it is then marked `stoppedAtTokenCap`, keeps its partial stream
 * and still gets the gate and a report row. `spawn`, `gateExec` and `setupExec` are injectable so tests
 * never start `claude`. With `setup`, that command runs in each clone (after the `with` clone's local
 * config is written) before any `claude` starts, with the `timeoutMin` timeout; a failing or timed-out
 * setup marks the run FAILED and skips both arms, so nothing is spent. If `claude` cannot be started the
 * run stops, the report is marked FAILED and `ok` is false; an arm whose `claude` exits non-zero without
 * a result line (and was not killed by the timeout or the token cap) also fails the run, but the other
 * arm still runs. The prompt goes on stdin; both arms get a --settings file switching the installed copy
 * of this plugin off, the same permission mode and tool list, and a clone that cannot push. The `with`
 * clone always gets a local config: `localConfig`'s contents, else `{ "gate": { "gate": <gate> } }`,
 * else `{}` (guided local mode either way).
 */
export async function runMeasure({
  repo, ref, prompt, model = 'sonnet', budgetUsd, maxTokens, out, gate, localConfig, task, setup, allowedTools = DEFAULT_ALLOWED_TOOLS,
  timeoutMin = DEFAULT_TIMEOUT_MIN, allowHighBudget = false,
  pluginDir = DEFAULT_PLUGIN_DIR, date = new Date().toISOString().slice(0, 10),
  spawn = nodeSpawn, gateExec, tmpRoot = tmpdir(), log = console.log, claude = resolveClaude(), platform = process.platform,
  rm = rmSync, setupExec = (command, cwd, ms) => shellSetupExec(command, cwd, ms, platform),
}) {
  const hasBudget = budgetUsd !== undefined && budgetUsd !== null;
  const hasTokens = maxTokens !== undefined && maxTokens !== null;
  if (!hasBudget && !hasTokens) {
    throw new UsageError('at least one cap is required: pass --max-tokens <tokens per arm> (subscription plans) or --budget <usd per arm> (API billing); refusing to run');
  }
  if (hasBudget) {
    if (typeof budgetUsd !== 'number' || !(budgetUsd > 0) || !Number.isFinite(budgetUsd)) {
      throw new UsageError('--budget <usd per arm> must be a number greater than 0; refusing to run');
    }
    if (budgetUsd > MAX_BUDGET_WITHOUT_FLAG && !allowHighBudget) {
      throw new UsageError(`--budget ${budgetUsd} is above ${MAX_BUDGET_WITHOUT_FLAG} USD per arm; pass --allow-high-budget if that is intended`);
    }
  }
  if (hasTokens) {
    if (!(typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0)) {
      throw new UsageError('--max-tokens <tokens per arm> must be a positive integer; refusing to run');
    }
    if (maxTokens > MAX_TOKENS_WITHOUT_FLAG && !allowHighBudget) {
      throw new UsageError(`--max-tokens ${maxTokens} is above ${MAX_TOKENS_WITHOUT_FLAG} per arm; pass --allow-high-budget if that is intended`);
    }
  }
  if (!(typeof timeoutMin === 'number' && timeoutMin > 0 && Number.isFinite(timeoutMin))) throw new UsageError('--timeout-min must be a positive number');
  if (setup !== undefined && (typeof setup !== 'string' || !setup.trim())) throw new UsageError('--setup must be a non-empty command');
  for (const [name, value] of [['--repo', repo], ['--ref', ref], ['--out', out]]) {
    if (typeof value !== 'string' || !value) throw new UsageError(`${name} is required`);
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw new UsageError('the prompt is empty');
  if (ref.startsWith('-') || repo.startsWith('-')) throw new UsageError('--repo and --ref must not start with "-"');
  const localConfigText = localConfig ? readFileSync(localConfig, 'utf8') : JSON.stringify(gate ? { gate: { gate } } : {});
  JSON.parse(localConfigText); // refuse a broken config before spending anything

  const totalCapUsd = hasBudget ? budgetUsd * ARMS.length : null;
  const totalCapTokens = hasTokens ? maxTokens * ARMS.length : null;
  if (hasBudget) {
    log(`Approximate total cap: ${totalCapUsd} USD (${ARMS.length} arms x ${budgetUsd} USD, --max-budget-usd per arm; the CLI may overshoot slightly). One run per arm.`);
  }
  if (hasTokens) log(`Token cap: ${maxTokens} per arm (${totalCapTokens} total)`);
  const capsText = [hasTokens ? `${maxTokens} tokens` : null, hasBudget ? `${budgetUsd} USD` : null].filter(Boolean).join(' and ');

  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const work = mkdtempSync(path.join(tmpRoot, 'nauraiz-measure-'));
  const settingsFile = path.join(work, 'settings.json');
  const arms = {};
  const gates = {};
  const written = [];
  const failures = [];
  const warnings = [];
  const clones = {};
  const setupSecs = {};
  let setupFailure = null;
  try {
    writeFileSync(settingsFile, settingsJson());
    // prepare both clones first, so a failing setup is found before any claude run spends anything
    for (const arm of ARMS) {
      const cwd = path.join(work, arm);
      log(`[${arm}] cloning ${repo} at ${ref}`);
      git(['clone', '--no-hardlinks', repo, cwd]);
      git(['checkout', '--detach', ref], cwd);
      git(['remote', 'set-url', '--push', 'origin', PUSH_DISABLED], cwd);
      const exclude = new Set();
      if (arm === 'with') {
        mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        writeFileSync(path.join(cwd, ...LOCAL_CONFIG_REL.split('/')), localConfigText);
        exclude.add(LOCAL_CONFIG_REL);
      }
      if (setup) {
        log(`[${arm}] setup: ${setup}`);
        const started = Date.now();
        let r;
        try { r = await setupExec(setup, cwd, timeoutMin * 60_000); } catch (e) { r = { code: 1, output: String(e?.message ?? e), timedOut: false }; }
        const secs = (Date.now() - started) / 1000;
        if (r.timedOut || r.code !== 0) {
          setupFailure = r.timedOut ? `timed out after ${timeoutMin} min` : `exit ${r.code ?? 'n/a'}`;
          failures.push(r.timedOut ? `setup timed out after ${timeoutMin} min in the ${arm} clone` : `setup failed in the ${arm} clone (${setupFailure})`);
          setupSecs[arm] = null;
          setupSecs.failedArm = arm;
          log(`[${arm}] ${failures.at(-1)}`);
          const tail = tailLines(r.output);
          if (tail) log(`[${arm}] setup output: ${tail}`);
          break;
        }
        setupSecs[arm] = secs;
        log(`[${arm}] setup ok (${secs.toFixed(1)} s)`);
        // what the setup left behind (node_modules, a lockfile) is not the arm's work
        for (const f of changedFiles(cwd, ref)) exclude.add(f);
      }
      clones[arm] = { cwd, exclude };
    }

    for (const arm of failures.length ? [] : ARMS) {
      const { cwd, exclude } = clones[arm];
      log(`[${arm}] running claude (cap ${capsText}, timeout ${timeoutMin} min)`);
      const args = buildArgs({ arm, model, budgetUsd: hasBudget ? budgetUsd : undefined, pluginDir, settingsFile, allowedTools });
      const run = await runClaude({
        spawn, command: claude, args, cwd, input: prompt, timeoutMs: timeoutMin * 60_000, platform,
        maxTokens: hasTokens ? maxTokens : 0,
        onTokenCap: (total) => log(`[${arm}] token cap reached (${total} of ${maxTokens}); stopping claude`),
      });
      if (run.spawnError) {
        failures.push(`claude could not be started for the ${arm} arm (${run.spawnError})`);
        arms[arm] = { ...parseStream(''), exit: null };
        log(`[${arm}] ${failures.at(-1)}`);
        break;
      }
      writeFileSync(`${out}.${arm}.jsonl`, run.stdout);
      written.push(`${out}.${arm}.jsonl`);
      if (run.code !== 0 && run.stderr?.trim()) log(`claude: ${run.stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}`);

      const files = changedFiles(cwd, ref, exclude);
      arms[arm] = {
        ...parseStream(run.stdout), exit: run.code, files, approvals: countApprovals(cwd, ref, files),
        timedOut: run.timedOut ? timeoutMin : false, stoppedAtTokenCap: run.stoppedAtTokenCap,
      };
      if (run.code !== 0 && !run.timedOut && !run.stoppedAtTokenCap && arms[arm].subtype === null) {
        failures.push(`the ${arm} arm: claude exited ${run.code ?? 'without a code'} with no result line`);
      }
      if (hasTokens && tokenCapNotEnforced(arms[arm], maxTokens)) {
        warnings.push(`the ${arm} arm: token cap reached but the arm was not stopped (${totalTokens(arms[arm])} tokens counted, cap ${maxTokens})`);
        log(`[${arm}] WARNING: ${warnings.at(-1)}`);
      }
      gates[arm] = null;
      if (gate) {
        const { ok, results } = await runGate({ cwd, config: { gate: { gate } }, exec: gateExec });
        gates[arm] = { ok, results };
      }
      log(`[${arm}] done: exit ${run.code ?? 'n/a'}${run.timedOut ? ' (timed out)' : ''}${run.stoppedAtTokenCap ? ' (stopped at the token cap)' : ''}, cost ${arms[arm].costUsd ?? 'n/a'} USD`);
    }
  } finally {
    // a locked file (Windows) must not cost the report: it is written below either way
    try { rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) {
      log(`could not delete the temp clones (${e.message}); remove ${work} by hand`);
    }
  }
  const failed = failures.length ? failures.join('; ') : null;
  for (const arm of ARMS) arms[arm] ??= { ...parseStream(''), exit: null };

  let setupInfo;
  if (setup) {
    const note = setupFailure === null
      ? `ok (${ARMS.map((a) => `${a} ${setupSecs[a].toFixed(1)} s`).join(', ')})`
      : `FAILED in the ${setupSecs.failedArm} clone (${setupFailure})`;
    setupInfo = { command: setup, note };
  }
  const firstLine = prompt.trim().split(/\r?\n/)[0];
  const md = formatReport({
    date, task: task ?? (firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine), prompt: prompt.trim(), model,
    arms, gate: gates, budgetUsd: hasBudget ? budgetUsd : null, maxTokens: hasTokens ? maxTokens : undefined, setup: setupInfo, allowedTools, failed, warnings,
  });
  writeFileSync(out, md);
  written.unshift(out);
  log(`Report: ${out}`);

  const leaks = scanLeaks({ files: written, pluginDir, tmpRoot });
  if (leaks.length) {
    log('WARNING: private material found in the output. Do NOT commit or publish these files before removing it:');
    for (const { file, label } of leaks) log(`WARNING:   ${file}: ${label}`);
  }
  return { reportPath: out, totalCapUsd, totalCapTokens, arms, gates, ok: failed === null, failed, leaks };
}

const BOOLEAN_FLAGS = new Set(['allow-high-budget']);

/**
 * Parse the CLI flags into runMeasure options. Throws on a missing required flag, a value flag given
 * without a value (never silently ignored: a lost cap flag must not turn into a different cap) or an
 * unreadable prompt file.
 */
export function parseCli(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (!flag.startsWith('--')) continue;
    const name = flag.slice(2);
    flags[name] = BOOLEAN_FLAGS.has(name) ? true : inline !== undefined ? inline : argv[++i];
    if (flags[name] === undefined) throw new UsageError(`--${name} needs a value`);
  }
  for (const name of ['repo', 'ref', 'prompt-file', 'out']) {
    if (!flags[name]) throw new UsageError(`--${name} is required`);
  }
  let prompt;
  try { prompt = readFileSync(flags['prompt-file'], 'utf8').trim(); } catch (e) {
    throw new UsageError(`cannot read the prompt file: ${e.message}`);
  }
  const opts = {
    repo: flags.repo,
    ref: flags.ref,
    prompt,
    model: flags.model ?? 'sonnet',
    budgetUsd: flags.budget === undefined ? undefined : Number(flags.budget),
    maxTokens: flags['max-tokens'] === undefined ? undefined : Number(flags['max-tokens']),
    out: flags.out,
    gate: flags.gate,
    localConfig: flags['local-config'],
    task: flags.task,
    setup: flags.setup,
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
    process.exit(exitCodeFor(e));
  }
  runMeasure(opts).then((r) => {
    if (!r.ok) { console.error(`nauraiz-dev: FAILED: ${r.failed}`); process.exit(1); }
  }).catch((e) => {
    console.error(`nauraiz-dev: ${e.message}`);
    process.exit(exitCodeFor(e));
  });
}
