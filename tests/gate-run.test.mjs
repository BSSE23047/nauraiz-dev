import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runGate, substitute, formatGate, FAIL_SUMMARY, main } from '../scripts/gate/run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fxGate = path.join(here, 'fixtures', 'gate');
const cli = path.join(here, '..', 'scripts', 'gate', 'run.mjs');
const node = (f) => `node "${path.join(fxGate, f)}"`;
const config = (gate, extra = {}) => ({ gate, branch: { base: 'main' }, plan: { dir: '.work/tasks' }, ...extra });
const allGate = { a: node('pass.mjs'), b: node('fail0.mjs'), c: node('red.mjs'), d: node('zero.mjs') };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'nd-gate-'));

test('runGate: statuses, exit-0-but-failing detection, exit codes', async () => {
  const { ok, results } = await runGate({ cwd: here, config: config(allGate) });
  assert.equal(ok, false);
  assert.deepEqual(results.map((r) => r.status), ['pass', 'fail', 'fail', 'pass']);
  assert.deepEqual(results.map((r) => r.name), ['a', 'b', 'c', 'd']);
  assert.equal(results[1].why, 'exit 0 but output reports failures');
  assert.equal(results[1].code, 0);
  assert.equal(results[2].code, 3);
  assert.equal(results[2].why, 'exit 3');
  assert.equal(results[0].tail, 'ok');
  assert.ok(Number.isFinite(results[0].ms));
});

test('runGate: --only filters, and an all-green selection is ok', async () => {
  const { ok, results } = await runGate({ cwd: here, config: config(allGate), only: ['a', 'd'] });
  assert.equal(ok, true);
  assert.equal(results.length, 2);
});

test('runGate: an --only that selects nothing is not ok', async () => {
  const r = await runGate({ cwd: here, config: config(allGate), only: ['zzz'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.results, []);
});

test('runGate: tail keeps the last 15 non-empty lines, stderr included', async () => {
  const exec = async () => ({ code: 0, output: Array.from({ length: 30 }, (_, i) => `l${i}\n\n`).join('') });
  const { results } = await runGate({ cwd: here, config: config({ x: 'whatever' }), exec });
  const lines = results[0].tail.split('\n');
  assert.equal(lines.length, 15);
  assert.equal(lines[0], 'l15');
  assert.equal(lines[14], 'l29');
  const real = await runGate({ cwd: here, config: config({ e: `node -e "console.error('to-stderr')"` }) });
  assert.match(real.results[0].tail, /to-stderr/);
});

test('runGate: ${base} falls back to the configured base outside git, ${plan} takes the explicit plan', async () => {
  const seen = [];
  const exec = async (command) => { seen.push(command); return { code: 0, output: 'ok' }; };
  const dir = tmp();
  try {
    const plan = path.join(dir, 'my plan.md');
    await runGate({ cwd: dir, config: config({ x: 'tool --base ${base} --plan ${plan}' }), plan, exec });
    assert.equal(seen[0], `tool --base main --plan "${plan}"`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runGate: ${plan} falls back to the branch plan', async () => {
  const dir = tmp();
  try {
    const git = (...a) => assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir }).status, 0);
    git('init', '-q', '-b', 'feature/x');
    git('commit', '-q', '--allow-empty', '-m', 'init'); // currentBranch needs a HEAD
    mkdirSync(path.join(dir, '.work', 'tasks'), { recursive: true });
    const planFile = path.join(dir, '.work', 'tasks', 'p.md');
    writeFileSync(planFile, '---\nbranch: feature/x\n---\n# P\n');
    const seen = [];
    const exec = async (command) => { seen.push(command); return { code: 0, output: 'ok' }; };
    const { ok } = await runGate({ cwd: dir, config: config({ x: 'check ${plan}' }), exec });
    assert.equal(ok, true);
    assert.equal(seen[0], `check ${planFile}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runGate: ${plan} with no plan is not run and fails; other commands still run', async () => {
  const dir = tmp();
  try {
    const seen = [];
    const exec = async (command) => { seen.push(command); return { code: 0, output: 'ok' }; };
    const { ok, results } = await runGate({ cwd: dir, config: config({ p: 'check ${plan}', q: 'plain' }), exec });
    assert.equal(ok, false);
    assert.deepEqual(seen, ['plain']);
    assert.equal(results[0].status, 'fail');
    assert.equal(results[0].why, 'no plan for this branch (pass --plan)');
    assert.equal(results[1].status, 'pass');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('substitute: every placeholder, quotes a path with spaces, not an already-quoted one', () => {
  assert.equal(substitute('x ${plan} --base ${base}', { plan: 'D:/a b/p.md', base: 'origin/dev' }), 'x "D:/a b/p.md" --base origin/dev');
  assert.equal(substitute('${base}..${base} ${plan}', { plan: 'p.md', base: 'dev' }), 'dev..dev p.md');
  assert.equal(substitute('x "${plan}"', { plan: 'D:/a b/p.md', base: 'b' }), 'x "D:/a b/p.md"');
  assert.equal(substitute('x ${plan}', { plan: 'a$&b', base: 'b' }), 'x a$&b');
});

test('FAIL_SUMMARY: failing summaries match, passing ones do not', () => {
  for (const s of ['FAIL  1 file(s) outside plan scope', 'Tests  2 failed', '# fail 1', 'Tests  1 failed (12)', '3 failing', 'Failures: 2']) {
    assert.ok(FAIL_SUMMARY.test(s), `should match: ${s}`);
  }
  for (const s of ['# fail 0', '0 failed', 'PASS (0 errors, 1 warnings)', 'Tests  0 failed, 12 passed', '0 failures, 12 passed', 'ok']) {
    assert.ok(!FAIL_SUMMARY.test(s), `should not match: ${s}`);
  }
});

test('formatGate: table row and a heading plus fenced tail per command', async () => {
  const { results } = await runGate({ cwd: here, config: config(allGate) });
  const md = formatGate(results);
  assert.match(md, /\| name \| status \| exit \| time \|/);
  assert.ok(md.includes('| b | fail | 0 |'));
  assert.ok(md.includes(`### ${node('fail0.mjs')}`));
  assert.ok(md.includes('```\nTests  1 failed (12)\n```'));
});

test('CLI: no gate configured exits 2 with the message', () => {
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), JSON.stringify({ enforcement: 'guided' }));
    const r = spawnSync(process.execPath, [cli, '--cwd', dir], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stdout + r.stderr, /nauraiz-dev: no gate configured in \.claude\/nauraiz-dev\(\.local\)\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: runs the gate in --cwd, honours --only, exits 0 green and 1 red', () => {
  const dir = tmp();
  try {
    const proj = path.join(dir, 'with space');
    mkdirSync(path.join(proj, '.claude'), { recursive: true });
    writeFileSync(path.join(proj, '.claude', 'nauraiz-dev.json'), JSON.stringify({ gate: allGate }));
    const green = spawnSync(process.execPath, [cli, '--cwd', proj, '--only', 'a,d'], { encoding: 'utf8' });
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /\| a \| pass \| 0 \|/);
    const red = spawnSync(process.execPath, [cli, '--cwd', proj], { encoding: 'utf8' });
    assert.equal(red.status, 1);
    assert.ok(red.stdout.includes('| b | fail | 0 |'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: --plan reaches ${plan}; a missing plan fails the command', () => {
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, '.claude'));
    const echo = path.join(fxGate, 'pass.mjs');
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), JSON.stringify({ gate: { p: `node "${echo}" \${plan}` } }));
    const none = spawnSync(process.execPath, [cli, '--cwd', dir], { encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.match(none.stdout, /no plan for this branch \(pass --plan\)/);
    const given = spawnSync(process.execPath, [cli, '--cwd', dir, '--plan', path.join(dir, 'x y.md')], { encoding: 'utf8' });
    assert.equal(given.status, 0, given.stdout + given.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: a config error is written to stderr (prefixed) before the table even when a gate exists', () => {
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), JSON.stringify({ gate: { a: node('pass.mjs') }, sharedPaths: 'src/**' }));
    const r = spawnSync(process.execPath, [cli, '--cwd', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /^nauraiz-dev: nauraiz-dev\.json: sharedPaths must be an array/m);
    assert.match(r.stdout, /\| a \| pass \| 0 \|/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('main: a runner crash returns exit 3 with a prefixed message on stderr', async () => {
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), JSON.stringify({ gate: { a: node('pass.mjs') } }));
    const out = [];
    const err = [];
    const code = await main(['--cwd', dir], {
      out: (s) => out.push(s), err: (s) => err.push(s),
      run: async () => { throw new Error('boom'); },
    });
    assert.equal(code, 3);
    assert.deepEqual(out, []);
    assert.match(err.join('\n'), /^nauraiz-dev: gate runner failed: boom$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('main returns 0 green, 1 red, 2 no gate; the CLI sets process.exitCode and never calls process.exit', async () => {
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, '.claude'));
    const write = (gate) => writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), JSON.stringify({ gate }));
    const quiet = { out: () => {}, err: () => {} };
    write({ a: node('pass.mjs') });
    assert.equal(await main(['--cwd', dir], quiet), 0);
    write({ c: node('red.mjs') });
    assert.equal(await main(['--cwd', dir], quiet), 1);
    write({});
    assert.equal(await main(['--cwd', dir], quiet), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.doesNotMatch(readFileSync(cli, 'utf8'), /process\.exit\(/);
});
