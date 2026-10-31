import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMeasure, parseCli, resolveClaude, spawnSpec, scanLeaks } from '../scripts/measure/run.mjs';
import { settingsJson } from '../scripts/measure/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stream = readFileSync(path.join(here, 'fixtures', 'measure', 'stream.jsonl'), 'utf8');

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A bare repo with two commits; returns { bare, first } where `first` holds v1.txt = "one" and no v2.txt. */
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

/**
 * A fake child_process.spawn. Records each call plus a snapshot of the clone at spawn time. Options:
 * text/code (the reply), onRun(cwd, callIndex) (mutate the clone like a working agent), throwErr (spawn
 * throws), errorEvent (emit 'error' like ENOENT), hang (never closes until killed).
 */
function fakeSpawn(calls, { text = stream, code = 0, onRun, throwErr, errorEvent, hang } = {}) {
  return (cmd, args, opts) => {
    if (throwErr) throw new Error(throwErr);
    const i = calls.length;
    const settingsAt = args.indexOf('--settings');
    const call = {
      cmd, args, opts, stdin: '',
      cwdFiles: readdirSync(opts.cwd),
      settingsText: settingsAt >= 0 && existsSync(args[settingsAt + 1]) ? readFileSync(args[settingsAt + 1], 'utf8') : null,
      pushUrl: git(opts.cwd, 'remote', 'get-url', '--push', 'origin'),
      fetchUrl: git(opts.cwd, 'remote', 'get-url', 'origin'),
      head: git(opts.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
      localConfig: existsSync(path.join(opts.cwd, '.claude', 'nauraiz-dev.local.json'))
        ? readFileSync(path.join(opts.cwd, '.claude', 'nauraiz-dev.local.json'), 'utf8') : null,
    };
    calls.push(call);
    onRun?.(opts.cwd, i);
    const child = new EventEmitter();
    child.stdin = new Writable({ write(chunk, enc, cb) { call.stdin += chunk; cb(); } });
    child.stdout = Readable.from([text]);
    child.stderr = Readable.from(['']);
    child.kill = () => { setImmediate(() => child.emit('close', null)); };
    if (errorEvent) setImmediate(() => child.emit('error', new Error(errorEvent)));
    else if (!hang) setImmediate(() => setImmediate(() => child.emit('close', code)));
    return child;
  };
}

const sandbox = () => mkdtempSync(path.join(tmpdir(), 'nd-measure-test-'));
const cleanup = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 5 });

test('runMeasure: fresh detached clones, prompt on stdin, settings file, push disabled, files and approvals from the clone', async () => {
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
    const prompt = 'Work on issue #7 on branch b.';
    const res = await runMeasure({
      repo: bare, ref: first, prompt, model: 'sonnet', budgetUsd: 3, out,
      gate: 'npm test', localConfig: cfg, pluginDir: path.join(root, 'plugin'), date: '2026-10-31', task: 'Issue 7',
      spawn: fakeSpawn(calls, {
        onRun(cwd, i) {
          writeFileSync(path.join(cwd, 'v1.txt'), 'changed');
          if (i === 0) writeFileSync(path.join(cwd, 'plan.md'), 'branch: b\nowner_approval: "yes, 2026-10-31"\nother_approval: pending owner confirmation\n');
          else { git(cwd, 'add', 'v1.txt'); git(cwd, 'commit', '-q', '-m', 'agent commit'); }
        },
      }),
      tmpRoot: tmp, log: (l) => logs.push(l),
      gateExec: async (command, cwd) => { gateCalls.push({ command, cwd }); return { code: 0, output: 'ok' }; },
    });

    assert.equal(res.ok, true);
    assert.equal(res.totalCapUsd, 6);
    assert.match(logs[0], /^Approximate total cap: 6 USD/);

    const [w, wo] = calls;
    assert.equal(calls.length, 2);
    assert.notEqual(w.opts.cwd, wo.opts.cwd);
    for (const c of calls) {
      assert.equal(c.opts.shell, false);
      assert.equal(c.stdin, prompt, 'the prompt arrives on stdin');
      assert.ok(!c.args.includes(prompt), 'no user text in argv');
      assert.deepEqual(c.args.slice(0, 1), ['-p']);
      assert.ok(c.args.includes('--permission-mode') && c.args[c.args.indexOf('--permission-mode') + 1] === 'acceptEdits');
      assert.ok(c.args.includes('--allowedTools'));
      assert.equal(c.settingsText, settingsJson(), 'both arms get the settings file');
      assert.ok(c.cwdFiles.includes('v1.txt') && !c.cwdFiles.includes('v2.txt'), 'checked out at the first commit');
      assert.equal(c.head, 'HEAD', 'detached');
      assert.equal(c.pushUrl, 'DISABLED-by-nauraiz-measure');
      assert.equal(c.fetchUrl, bare);
    }
    assert.ok(w.args.includes('--plugin-dir') && !wo.args.includes('--plugin-dir'));
    assert.equal(w.localConfig, '{"gate":{"test":"npm test"}}');
    assert.equal(wo.localConfig, null);
    assert.deepEqual(gateCalls.map((g) => g.cwd), [w.opts.cwd, wo.opts.cwd]);

    assert.equal(readFileSync(`${out}.with.jsonl`, 'utf8'), stream);
    assert.equal(readFileSync(`${out}.without.jsonl`, 'utf8'), stream);
    const md = readFileSync(out, 'utf8');
    assert.ok(md.includes('| files touched | plan.md, v1.txt | v1.txt |'), md);
    assert.ok(md.includes('| approvals recorded | 1 | 0 |'));
    assert.ok(md.includes('| gate | pass | pass |'));
    assert.ok(md.includes('| output tokens | 150 | 150 |'));
    assert.ok(md.includes('git remote set-url --push origin DISABLED-by-nauraiz-measure'));
    assert.ok(!md.includes(root) && !md.includes('src/a.js'), 'no local paths, no raw tool paths');
    assert.match(md, /n=1 per arm; not a benchmark\./);
    assert.ok(!logs.some((l) => l.startsWith('WARNING')), 'a clean run prints no warning');

    assert.deepEqual(readdirSync(tmp), [], 'temp clones and the settings file are deleted');
  } finally {
    cleanup(root);
  }
});

test('runMeasure: refuses without a positive budget, above 20 USD without the flag, or with a bad timeout; nothing is created', async () => {
  const root = sandbox();
  try {
    const calls = [];
    const base = { repo: root, ref: 'x', prompt: 'p', model: 'sonnet', out: path.join(root, 'r.md'), spawn: fakeSpawn(calls), tmpRoot: root, log() {} };
    for (const budgetUsd of [undefined, 0, -1, 'abc', NaN]) await assert.rejects(runMeasure({ ...base, budgetUsd }), /--budget/);
    await assert.rejects(runMeasure({ ...base, budgetUsd: 21 }), /--allow-high-budget/);
    await assert.rejects(runMeasure({ ...base, budgetUsd: 3, timeoutMin: 0 }), /--timeout-min/);
    assert.equal(calls.length, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    cleanup(root);
  }
});

test('runMeasure: a non-zero claude exit with no result line fails the run (ok false, report FAILED); the gate still runs; clones deleted', async () => {
  const root = sandbox();
  try {
    const { bare, first } = makeBare(root);
    const tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    const out = path.join(root, 'r.md');
    const res = await runMeasure({
      repo: bare, ref: first, prompt: 'p', model: 'sonnet', budgetUsd: 1, out, gate: 'true', pluginDir: '/p', date: 'd', task: 't',
      spawn: fakeSpawn([], { text: '', code: 1 }), tmpRoot: tmp, log() {}, gateExec: async () => ({ code: 0, output: '' }),
    });
    assert.equal(res.ok, false);
    assert.match(res.failed, /the with arm: claude exited 1 with no result line/);
    assert.match(res.failed, /the without arm: claude exited 1 with no result line/);
    const md = readFileSync(out, 'utf8');
    assert.ok(md.startsWith('**FAILED: the with arm: claude exited 1 with no result line'), md.slice(0, 200));
    assert.ok(md.includes('| claude exit code | 1 | 1 |'));
    assert.ok(md.includes('| result | FAILED: no result line in the stream | FAILED: no result line in the stream |'));
    assert.ok(md.includes('| gate | pass | pass |'));
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    cleanup(root);
  }
});

test('runMeasure: claude that cannot be started (throw or ENOENT) stops the run, marks the report FAILED, skips the gate', async () => {
  for (const variant of [{ throwErr: 'spawn EINVAL' }, { errorEvent: 'spawn claude ENOENT' }]) {
    const root = sandbox();
    try {
      const { bare, first } = makeBare(root);
      const tmp = path.join(root, 'tmp');
      mkdirSync(tmp);
      const out = path.join(root, 'r.md');
      const calls = [];
      let gateRuns = 0;
      const logs = [];
      const res = await runMeasure({
        repo: bare, ref: first, prompt: 'p', model: 'sonnet', budgetUsd: 1, out, gate: 'true', pluginDir: '/p', date: 'd', task: 't',
        spawn: fakeSpawn(calls, variant), tmpRoot: tmp, log: (l) => logs.push(l),
        gateExec: async () => { gateRuns++; return { code: 0, output: '' }; },
      });
      assert.equal(res.ok, false);
      assert.match(res.failed, /could not be started for the with arm/);
      assert.equal(gateRuns, 0, 'no gate for an arm that never ran');
      assert.ok(readFileSync(out, 'utf8').startsWith('**FAILED: claude could not be started for the with arm'));
      assert.ok(!existsSync(`${out}.without.jsonl`), 'the second arm never started');
      assert.deepEqual(readdirSync(tmp), []);
    } finally {
      cleanup(root);
    }
  }
});

test('runMeasure: an arm that outlives --timeout-min is killed and marked, not treated as a spawn failure', async () => {
  const root = sandbox();
  try {
    const { bare, first } = makeBare(root);
    const tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    const out = path.join(root, 'r.md');
    const res = await runMeasure({
      repo: bare, ref: first, prompt: 'p', model: 'sonnet', budgetUsd: 1, out, pluginDir: '/p', date: 'd', task: 't',
      timeoutMin: 0.001, spawn: fakeSpawn([], { hang: true }), tmpRoot: tmp, log() {},
    });
    assert.equal(res.ok, true);
    assert.ok(readFileSync(out, 'utf8').includes('| result | FAILED: killed after the 0.001 min timeout | FAILED: killed after the 0.001 min timeout |'));
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    cleanup(root);
  }
});

test('runMeasure: with only a win32 claude.cmd the arm is spawned through the shell with double-quoted parts', async () => {
  const root = sandbox();
  try {
    const { bare, first } = makeBare(root);
    const tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    const calls = [];
    await runMeasure({
      repo: bare, ref: first, prompt: 'p', model: 'sonnet', budgetUsd: 1, out: path.join(root, 'r.md'), pluginDir: 'C:\\plug in',
      claude: 'C:\\npm\\claude.cmd', platform: 'win32', spawn: fakeSpawn(calls), tmpRoot: tmp, log() {},
    });
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.opts.shell, true);
      assert.equal(c.cmd, '"C:\\npm\\claude.cmd"');
      assert.ok(c.args.every((a) => a.startsWith('"') && a.endsWith('"')), 'every argument is double-quoted');
      assert.equal(c.stdin, 'p');
    }
    assert.ok(calls[0].args.includes('"C:\\plug in"'));
  } finally {
    cleanup(root);
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
    cleanup(root);
  }
});

test('runMeasure: private material in the streams or report prints a loud WARNING; the forbidden term itself is not printed', async () => {
  const root = sandbox();
  try {
    const { bare, first } = makeBare(root);
    const tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    const plugin = path.join(root, 'plugin');
    mkdirSync(plugin);
    writeFileSync(path.join(plugin, '.forbidden-terms'), 'Zorblax\n');
    const dirty = `${stream}\n${JSON.stringify({ type: 'user', cwd: homedir(), note: 'Zorblax Ltd' })}\n`;
    const logs = [];
    const out = path.join(root, 'r.md');
    const res = await runMeasure({
      repo: bare, ref: first, prompt: 'p', model: 'sonnet', budgetUsd: 1, out, pluginDir: plugin, date: 'd', task: 't',
      spawn: fakeSpawn([], { text: dirty }), tmpRoot: tmp, log: (l) => logs.push(l),
    });
    const warnings = logs.filter((l) => l.startsWith('WARNING'));
    assert.ok(warnings[0].includes('Do NOT commit or publish'));
    assert.ok(warnings.some((l) => l.includes(`${out}.with.jsonl`) && l.includes('home directory')));
    assert.ok(warnings.some((l) => l.includes('forbidden term')));
    assert.ok(!warnings.join('\n').toLowerCase().includes('zorblax'));
    assert.ok(res.leaks.length >= 2);
  } finally {
    cleanup(root);
  }
});

test('scanLeaks: matches each spelling of a path and whole-word forbidden terms only', () => {
  const root = sandbox();
  try {
    const plugin = path.join(root, 'plugin');
    mkdirSync(plugin);
    writeFileSync(path.join(plugin, '.forbidden-terms'), 'acme\n');
    const f = path.join(root, 'f.txt');
    const home = 'C:\\Users\\Someone';
    writeFileSync(f, JSON.stringify({ p: home }) + ' acmeville');
    const hits = scanLeaks({ files: [f], pluginDir: plugin, tmpRoot: '', home });
    assert.deepEqual(hits.map((h) => h.label), ['home directory'], 'JSON-escaped spelling matches; "acmeville" is not the word acme');
    writeFileSync(f, 'see c:/users/someone/x and ACME.');
    assert.deepEqual(scanLeaks({ files: [f], pluginDir: plugin, tmpRoot: '', home }).map((h) => h.label), ['home directory', 'forbidden term (see .forbidden-terms)']);
  } finally {
    cleanup(root);
  }
});

test('parseCli: reads every flag, requires the inputs, never defaults the budget', () => {
  const root = sandbox();
  try {
    const pf = path.join(root, 'prompt.txt');
    writeFileSync(pf, 'Work on issue #1.\n');
    const o = parseCli(['--repo', 'r', '--ref', 'abc', '--prompt-file', pf, '--model', 'sonnet', '--budget', '3', '--out', 'o.md', '--gate', 'npm test', '--local-config', 'c.json',
      '--allowed-tools', 'Read Glob', '--timeout-min', '10', '--allow-high-budget']);
    assert.equal(o.repo, 'r');
    assert.equal(o.ref, 'abc');
    assert.equal(o.prompt, 'Work on issue #1.');
    assert.equal(o.model, 'sonnet');
    assert.equal(o.budgetUsd, 3);
    assert.equal(o.gate, 'npm test');
    assert.equal(o.localConfig, 'c.json');
    assert.equal(o.allowedTools, 'Read Glob');
    assert.equal(o.timeoutMin, 10);
    assert.equal(o.allowHighBudget, true);
    const bare = parseCli(['--repo', 'r', '--ref', 'abc', '--prompt-file', pf, '--out', 'o.md']);
    assert.equal(bare.budgetUsd, undefined);
    assert.equal(bare.model, 'sonnet');
    assert.equal(bare.allowHighBudget, false);
    assert.equal('allowedTools' in bare, false);
    assert.equal('timeoutMin' in bare, false);
    assert.throws(() => parseCli(['--repo', 'r']), /--ref|--prompt-file|--out/);
    assert.throws(() => parseCli(['--repo', 'r', '--ref', 'a', '--prompt-file', path.join(root, 'nope'), '--out', 'o']), /prompt/i);
  } finally {
    cleanup(root);
  }
});

test('spawnSpec: a win32 .cmd/.bat shim goes through the shell with quoted parts; everything else does not', () => {
  assert.deepEqual(spawnSpec('C:\\n\\claude.cmd', ['-p', 'a b'], 'win32'), { command: '"C:\\n\\claude.cmd"', args: ['"-p"', '"a b"'], shell: true });
  assert.deepEqual(spawnSpec('C:\\n\\claude.exe', ['-p'], 'win32'), { command: 'C:\\n\\claude.exe', args: ['-p'], shell: false });
  assert.deepEqual(spawnSpec('/x/claude.cmd', ['-p'], 'linux'), { command: '/x/claude.cmd', args: ['-p'], shell: false });
  assert.throws(() => spawnSpec('C:\\n\\claude.cmd', ['a"b'], 'win32'), /cmd\.exe/);
  assert.throws(() => spawnSpec('C:\\n\\claude.cmd', ['%PATH%'], 'win32'), /cmd\.exe/);
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

test('runMeasure: a non-zero exit that still wrote a result line is not a failed run', async () => {
  const root = sandbox();
  try {
    const { bare, first } = makeBare(root);
    const tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    const res = await runMeasure({
      repo: bare, ref: first, prompt: 'p', model: 'sonnet', budgetUsd: 1, out: path.join(root, 'r.md'), pluginDir: '/p', date: 'd', task: 't',
      spawn: fakeSpawn([], { code: 1 }), tmpRoot: tmp, log() {},
    });
    assert.equal(res.ok, true);
    assert.equal(res.failed, null);
  } finally {
    cleanup(root);
  }
});

test('runMeasure: without --local-config the with clone gets a guided local config holding the --gate command, or {} without a gate', async () => {
  for (const [gate, expected] of [['npm test', { gate: { gate: 'npm test' } }], [undefined, {}]]) {
    const root = sandbox();
    try {
      const { bare, first } = makeBare(root);
      const tmp = path.join(root, 'tmp');
      mkdirSync(tmp);
      const calls = [];
      const out = path.join(root, 'r.md');
      await runMeasure({
        repo: bare, ref: first, prompt: 'p', model: 'sonnet', budgetUsd: 1, out, gate, pluginDir: '/p', date: 'd', task: 't',
        spawn: fakeSpawn(calls), tmpRoot: tmp, log() {}, gateExec: async () => ({ code: 0, output: '' }),
      });
      const [w, wo] = calls;
      assert.deepEqual(JSON.parse(w.localConfig), expected, String(gate));
      assert.equal(wo.localConfig, null);
      assert.ok(readFileSync(out, 'utf8').includes('| files touched | none | none |'), 'the written local config is not counted as touched');
    } finally {
      cleanup(root);
    }
  }
});

test('runMeasure: a failure to delete the temp clones never loses the report', async () => {
  const root = sandbox();
  try {
    const { bare, first } = makeBare(root);
    const tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    const out = path.join(root, 'r.md');
    const logs = [];
    const res = await runMeasure({
      repo: bare, ref: first, prompt: 'p', model: 'sonnet', budgetUsd: 1, out, pluginDir: '/p', date: 'd', task: 't',
      spawn: fakeSpawn([]), tmpRoot: tmp, log: (l) => logs.push(l), rm: () => { throw new Error('EBUSY: locked'); },
    });
    assert.equal(res.ok, true);
    assert.ok(existsSync(out));
    assert.ok(logs.some((l) => /could not delete the temp clones/.test(l) && /EBUSY/.test(l)), logs.join('\n'));
  } finally {
    cleanup(root);
  }
});
