import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMeasure, parseCli, resolveClaude } from '../scripts/measure/run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stream = readFileSync(path.join(here, 'fixtures', 'measure', 'stream.jsonl'), 'utf8');

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A bare repo with two commits; returns { bare, first } where `first` holds v1.txt = "one". */
function makeBare(root) {
  const work = path.join(root, 'work dir');
  mkdirSync(work);
  git(work, 'init', '-q');
  writeFileSync(path.join(work, 'v1.txt'), 'one');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  const first = git(work, 'rev-parse', 'HEAD');
  writeFileSync(path.join(work, 'v2.txt'), 'two');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'second');
  const bare = path.join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', work, bare);
  return { bare, first };
}

/** A fake child_process.spawn: records calls, snapshots the clone at spawn time, replies with `text`. */
function fakeSpawn(calls, { text = stream, code = 0 } = {}) {
  return (cmd, args, opts) => {
    calls.push({
      cmd, args, opts,
      cwdFiles: readdirSync(opts.cwd),
      localConfig: existsSync(path.join(opts.cwd, '.claude', 'nauraiz-dev.local.json'))
        ? readFileSync(path.join(opts.cwd, '.claude', 'nauraiz-dev.local.json'), 'utf8') : null,
    });
    const child = new EventEmitter();
    child.stdout = Readable.from([text]);
    child.stderr = Readable.from(['']);
    setImmediate(() => setImmediate(() => child.emit('close', code)));
    return child;
  };
}

const sandbox = () => mkdtempSync(path.join(tmpdir(), 'nd-measure-test-'));

test('runMeasure: two fresh clones at the ref, local config only in the with clone, streams and report written, clones deleted', async () => {
  const root = sandbox();
  try {
    const { bare, first } = makeBare(root);
    const tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    const cfg = path.join(root, 'local.json');
    writeFileSync(cfg, '{"gate":{"test":"npm test"}}');
    const out = path.join(root, 'reports', 'run.md');
    const calls = [];
    const logs = [];
    const gateCalls = [];
    const res = await runMeasure({
      repo: bare, ref: first, prompt: 'Work on issue #7 on branch b.', model: 'sonnet', budgetUsd: 3, out,
      gate: 'npm test', localConfig: cfg, pluginDir: path.join(root, 'plugin'), date: '2026-10-31', task: 'Issue 7',
      spawn: fakeSpawn(calls), tmpRoot: tmp, log: (l) => logs.push(l),
      gateExec: async (command, cwd) => { gateCalls.push({ command, cwd }); return { code: 0, output: 'ok' }; },
    });

    assert.equal(res.totalCapUsd, 6);
    assert.ok(logs.some((l) => /6/.test(l) && /cap/i.test(l)), 'prints the total cap before running');
    assert.ok(logs.findIndex((l) => /cap/i.test(l)) < 1, 'cap is printed first');

    assert.equal(calls.length, 2);
    const [w, wo] = calls;
    assert.equal(w.opts.shell, false);
    assert.equal(wo.opts.shell, false);
    assert.notEqual(w.opts.cwd, wo.opts.cwd);
    assert.match(path.basename(w.cmd).toLowerCase(), /^claude/);
    assert.ok(w.args.includes('--plugin-dir') && !w.args.includes('--settings'));
    assert.ok(wo.args.includes('--settings') && !wo.args.includes('--plugin-dir'));
    assert.deepEqual(w.args.slice(0, 2), ['-p', 'Work on issue #7 on branch b.']);
    for (const c of calls) {
      assert.ok(c.cwdFiles.includes('v1.txt') && !c.cwdFiles.includes('v2.txt'), 'checked out at the first commit');
    }
    assert.equal(w.localConfig, '{"gate":{"test":"npm test"}}');
    assert.equal(wo.localConfig, null);

    assert.equal(gateCalls.length, 2);
    assert.deepEqual(gateCalls.map((g) => g.cwd), [w.opts.cwd, wo.opts.cwd]);

    assert.equal(readFileSync(`${out}.with.jsonl`, 'utf8'), stream);
    assert.equal(readFileSync(`${out}.without.jsonl`, 'utf8'), stream);
    const md = readFileSync(out, 'utf8');
    assert.match(md, /\| gate \| pass \| pass \|/);
    assert.match(md, /\| output tokens \| 150 \| 150 \|/);
    assert.match(md, /n=1 per arm; not a benchmark\./);

    assert.deepEqual(readdirSync(tmp), [], 'temp clones deleted');
    assert.ok(!existsSync(w.opts.cwd) && !existsSync(wo.opts.cwd));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('runMeasure: refuses without a positive budget, before cloning or spawning anything', async () => {
  const root = sandbox();
  try {
    const calls = [];
    for (const budgetUsd of [undefined, 0, -1, 'abc', NaN]) {
      await assert.rejects(
        runMeasure({ repo: root, ref: 'x', prompt: 'p', model: 'sonnet', budgetUsd, out: path.join(root, 'r.md'), spawn: fakeSpawn(calls), tmpRoot: root, log() {} }),
        /--budget/,
      );
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runMeasure: a failed claude run is recorded (exit code, empty stream) and the clones are still deleted', async () => {
  const root = sandbox();
  try {
    const { bare, first } = makeBare(root);
    const tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    const out = path.join(root, 'r.md');
    await runMeasure({
      repo: bare, ref: first, prompt: 'p', model: 'sonnet', budgetUsd: 1, out, pluginDir: '/p', date: 'd', task: 't',
      spawn: fakeSpawn([], { text: '', code: 1 }), tmpRoot: tmp, log() {},
    });
    assert.match(readFileSync(out, 'utf8'), /\| claude exit code \| 1 \| 1 \|/);
    assert.match(readFileSync(out, 'utf8'), /\| gate \| not run \| not run \|/);
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('runMeasure: a ref that does not exist rejects and leaves no clone behind', async () => {
  const root = sandbox();
  try {
    const { bare } = makeBare(root);
    const tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    const calls = [];
    await assert.rejects(
      runMeasure({ repo: bare, ref: 'does-not-exist', prompt: 'p', model: 'sonnet', budgetUsd: 1, out: path.join(root, 'r.md'), pluginDir: '/p', spawn: fakeSpawn(calls), tmpRoot: tmp, log() {} }),
      /checkout/,
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('parseCli: reads every flag, requires the inputs, never defaults the budget', () => {
  const root = sandbox();
  try {
    const pf = path.join(root, 'prompt.txt');
    writeFileSync(pf, 'Work on issue #1.\n');
    const o = parseCli(['--repo', 'r', '--ref', 'abc', '--prompt-file', pf, '--model', 'sonnet', '--budget', '3', '--out', 'o.md', '--gate', 'npm test', '--local-config', 'c.json']);
    assert.equal(o.repo, 'r');
    assert.equal(o.ref, 'abc');
    assert.equal(o.prompt, 'Work on issue #1.');
    assert.equal(o.model, 'sonnet');
    assert.equal(o.budgetUsd, 3);
    assert.equal(o.gate, 'npm test');
    assert.equal(o.localConfig, 'c.json');
    const bare = parseCli(['--repo', 'r', '--ref', 'abc', '--prompt-file', pf, '--out', 'o.md']);
    assert.equal(bare.budgetUsd, undefined);
    assert.equal(bare.model, 'sonnet');
    assert.throws(() => parseCli(['--repo', 'r']), /--ref|--prompt-file|--out/);
    assert.throws(() => parseCli(['--repo', 'r', '--ref', 'a', '--prompt-file', path.join(root, 'nope'), '--out', 'o']), /prompt/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClaude: the directly executable claude wins; win32 falls back to claude.cmd; else plain claude', () => {
  const sep = path.delimiter;
  const env = { PATH: ['/a', '/b'].join(sep) };
  const has = (set) => (p) => set.includes(p.split(path.sep).join('/'));
  assert.equal(resolveClaude({ env, platform: 'linux', exists: has(['/b/claude']) }).split(path.sep).join('/'), '/b/claude');
  assert.equal(resolveClaude({ env, platform: 'win32', exists: has(['/a/claude.cmd']) }).split(path.sep).join('/'), '/a/claude.cmd');
  assert.equal(resolveClaude({ env, platform: 'win32', exists: has(['/a/claude.exe', '/a/claude.cmd']) }).split(path.sep).join('/'), '/a/claude.exe');
  assert.equal(resolveClaude({ env, platform: 'linux', exists: () => false }), 'claude');
});
