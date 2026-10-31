#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isMain } from '../lib/main.mjs';
import { loadConfig } from '../lib/config.mjs';
import { resolveBase } from '../lib/base.mjs';
import { currentBranch } from '../lib/git.mjs';
import { findPlanForBranch } from '../lib/plan.mjs';
import { findProjectRoot } from '../lib/root.mjs';

const TAIL_LINES = 15;
const NO_PLAN = 'no plan for this branch (pass --plan)';

/**
 * A command that exits 0 can still report failures (`Tests  1 failed`, `FAIL  1 file(s)`, TAP `# fail 1`).
 * Matches a failure word followed by a non-zero count, or a non-zero count followed by a failure word.
 * Zero counts (`# fail 0`, `0 failed, 12 passed`) do not match.
 */
export const FAIL_SUMMARY = /(?:^|\s)(?:#\s*)?fail(?:ed|ing|ures?)?\b[ \t:=]{0,12}[1-9]\d*|\b[1-9]\d*\s+(?:failed|failing|failures?)\b/im;

const quote = (v) => (/\s/.test(v) ? `"${v}"` : v);

/**
 * Replace every `${plan}` / `${base}`. A value containing whitespace is wrapped in double quotes unless
 * the placeholder already sits inside double quotes. Values are inserted literally (no `$&` expansion).
 */
export function substitute(command, { plan, base }) {
  const values = { plan, base };
  return command.replace(/\$\{(plan|base)\}/g, (m, name, offset, str) => {
    const v = values[name];
    if (typeof v !== 'string') return m;
    return str[offset - 1] === '"' && str[offset + m.length] === '"' ? v : quote(v);
  });
}

/** Default executor: run `command` through the shell in `cwd`, stdout and stderr interleaved. */
function shellExec(command, cwd) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: 1, output: String(e.message) });
      return;
    }
    const take = (chunk) => { output += chunk; };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);
    child.on('error', (e) => resolve({ code: 1, output: output + String(e.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

const lastLines = (text) => text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-TAIL_LINES).join('\n');

/**
 * Run the configured gate commands one after another.
 * `plan` is an optional explicit plan path; when absent and a command uses `${plan}`, the plan for the
 * current branch is looked up. A `${plan}` command with no plan is not run: it fails with `NO_PLAN`
 * (`code: null`). `only` limits the run to those gate names. `ok` is false when nothing was selected.
 */
export async function runGate({ cwd, config, plan, only, exec = shellExec }) {
  const gate = config?.gate ?? {};
  let entries = Object.entries(gate).filter(([, v]) => typeof v === 'string' && v.trim() !== '');
  if (Array.isArray(only) && only.length) entries = entries.filter(([name]) => only.includes(name));

  const base = resolveBase(cwd, config?.branch?.base ?? 'main');
  let planPath = plan || null;
  if (!planPath && entries.some(([, v]) => v.includes('${plan}'))) {
    planPath = findPlanForBranch(cwd, config?.plan?.dir ?? '.work/tasks', currentBranch(cwd))?.path ?? null;
  }

  const results = [];
  for (const [name, template] of entries) {
    if (template.includes('${plan}') && !planPath) {
      results.push({ name, command: template, code: null, ms: 0, tail: '', status: 'fail', why: NO_PLAN });
      continue;
    }
    const command = substitute(template, { plan: planPath, base });
    const started = Date.now();
    const { code, output } = await exec(command, cwd);
    const ms = Date.now() - started;
    const tail = lastLines(String(output ?? ''));
    let status = 'pass';
    let why = '';
    if (code !== 0) { status = 'fail'; why = `exit ${code}`; }
    else if (FAIL_SUMMARY.test(tail)) { status = 'fail'; why = 'exit 0 but output reports failures'; }
    results.push({ name, command, code, ms, tail, status, why });
  }
  return { ok: results.length > 0 && results.every((r) => r.status === 'pass'), results };
}

const cell = (v) => String(v).replace(/\|/g, '\\|');

/** Markdown report: a results table, then each command's heading, reason (if failed) and fenced tail. */
export function formatGate(results) {
  const lines = ['| name | status | exit | time |', '| --- | --- | --- | --- |'];
  for (const r of results) lines.push(`| ${cell(r.name)} | ${r.status} | ${r.code ?? '-'} | ${r.ms}ms |`);
  for (const r of results) {
    const longest = Math.max(2, ...(r.tail.match(/`+/g) ?? []).map((s) => s.length));
    const fence = '`'.repeat(longest + 1);
    lines.push('', `### ${r.command}`);
    if (r.status === 'fail') lines.push('', `Failed: ${r.why}`);
    lines.push('', fence, r.tail, fence);
  }
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = { plan: undefined, only: undefined, cwd: undefined };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--plan') opts.plan = value();
    else if (flag === '--only') opts.only = String(value() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--cwd') opts.cwd = path.resolve(value() ?? process.cwd());
  }
  return opts;
}

/**
 * The CLI: returns the exit code instead of exiting. 0 every command passed, 1 a command failed (or no
 * command matched --only), 2 no gate configured, 3 the runner itself failed. A config error always goes
 * to stderr first. Without `--cwd` the project root is found by walking up from `start` (see
 * `findProjectRoot`); one stderr line names the root the commands run in. `out`, `err`, `run`, `start`
 * and `gitTop` are injectable for tests.
 */
export async function main(argv, { out = console.log, err = console.error, run = runGate, start = process.cwd(), gitTop } = {}) {
  try {
    const parsed = parseArgs(argv);
    const { plan, only } = parsed;
    const cwd = parsed.cwd ?? findProjectRoot(start, gitTop);
    err(`nauraiz-dev gate: project root ${cwd}`);
    const { config, error } = loadConfig(cwd);
    if (error) err(`nauraiz-dev: ${error}`);
    const hasGate = Object.values(config.gate ?? {}).some((v) => typeof v === 'string' && v.trim() !== '');
    if (!hasGate) {
      out('nauraiz-dev: no gate configured in .claude/nauraiz-dev(.local).json');
      return 2;
    }
    const { ok, results } = await run({ cwd, config, plan, only });
    if (results.length === 0) out(`nauraiz-dev: no gate command named ${(only ?? []).join(', ')}`);
    else out(formatGate(results));
    return ok ? 0 : 1;
  } catch (e) {
    err(`nauraiz-dev: gate runner failed: ${e?.message ?? e}`);
    return 3;
  }
}

if (isMain(import.meta.url)) {
  // set exitCode rather than exiting at once, so piped stdout is flushed
  process.exitCode = await main(process.argv.slice(2));
}
