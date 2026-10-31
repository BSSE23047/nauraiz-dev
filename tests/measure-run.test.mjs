import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMeasure, parseCli, resolveClaude, spawnSpec, scanLeaks, shellSetupExec, exitCodeFor, UsageError } from '../scripts/measure/run.mjs';
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
 * throws), errorEvent (emit 'error' like ENOENT), hang (never closes until killed), chunks (stdout one
 * chunk per tick, cut once killed), pid (give the child a pid, so the harness takes the tree-kill path).
 */
function fakeSpawn(calls, { text = stream, code = 0, onRun, throwErr, errorEvent, hang, chunks, events, pid } = {}) {
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
    call.killed = 0;
    calls.push(call);
    events?.push('spawn');
    onRun?.(opts.cwd, i);
    const child = new EventEmitter();
    if (pid) child.pid = pid;
    child.stdin = new Writable({ write(chunk, enc, cb) { call.stdin += chunk; cb(); } });
    if (chunks) {
      // one chunk per tick; nothing more once the harness has killed the child (a cut stream)
      const queue = [...chunks];
      const r = new Readable({ read() {} });
      const pump = () => {
        if (call.killed > 0) return;
        if (queue.length === 0) { r.push(null); return; }
        r.push(queue.shift());
        setImmediate(pump);
      };
      setImmediate(pump);
      child.stdout = r;
    } else child.stdout = Readable.from([text]);
    child.stderr = Readable.from(['']);
    child.kill = () => { call.killed++; setImmediate(() => child.emit('close', null)); };
    if (errorEvent) setImmediate(() => child.emit('error', new Error(errorEvent)));
    else if (chunks) child.stdout.on('end', () => setImmediate(() => child.emit('close', code)));
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
    assert.ok(md.includes('| output tokens | 175 | 175 |'));
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
    assert.equal(bare.maxTokens, undefined);
    assert.equal(bare.setup, undefined);
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

const assistantLine = (id, tokens) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 0, output_tokens: tokens }, content: [] } }) + '\n';

async function runWith(extra = {}, spawnOpts = {}) {
  const root = sandbox();
  const tmp = path.join(root, 'tmp');
  try {
    const { bare, first } = makeBare(root);
    mkdirSync(tmp);
    const calls = [];
    const logs = [];
    const out = path.join(root, 'r.md');
    const gateCalls = [];
    const res = await runMeasure({
      repo: bare, ref: first, prompt: 'p', model: 'sonnet', out, pluginDir: '/p', date: 'd', task: 't', tmpRoot: tmp,
      log: (l) => logs.push(l), spawn: fakeSpawn(calls, spawnOpts),
      gateExec: async (command, cwd) => { gateCalls.push(cwd); return { code: 0, output: '' }; },
      ...extra,
    });
    return {
      res, calls, logs, gateCalls, md: readFileSync(out, 'utf8'), out, tmp, bare, tmpLeft: readdirSync(tmp),
      withStream: existsSync(`${out}.with.jsonl`) ? readFileSync(`${out}.with.jsonl`, 'utf8') : null,
    };
  } finally {
    cleanup(root);
  }
}

test('runMeasure: an arm whose streamed usage reaches --max-tokens is killed, marked, keeps its partial stream and still gets the gate and a report', async () => {
  // m1 counts 60 once (a repeat of the same id must not count again): 60 < 100, so no kill at either m1 line;
  // m2 brings the count to 110 and that is where the stream is cut (m3 never reaches the file)
  const chunks = [assistantLine('m1', 60), assistantLine('m1', 60), assistantLine('m2', 50), assistantLine('m3', 5000)];
  const r = await runWith({ maxTokens: 100, gate: 'true' }, { chunks });
  assert.equal(r.res.ok, true);
  assert.deepEqual(r.calls.map((c) => c.killed), [1, 1], 'each arm was killed exactly once');
  assert.equal(r.res.arms.with.stoppedAtTokenCap, true);
  assert.equal(r.res.arms.without.stoppedAtTokenCap, true);
  assert.equal(r.gateCalls.length, 2, 'the gate still ran in both clones');
  assert.ok(r.md.includes('| stopped at token cap | yes | yes |'), r.md);
  assert.ok(r.md.includes('| result | FAILED: stopped at the token cap | FAILED: stopped at the token cap |'), r.md);
  assert.ok(r.md.includes('| gate | pass | pass |'));
  assert.match(r.md, /Token cap: 100 weighted tokens per arm \(cache reads count 0\.1\)\./);
  assert.equal(r.logs.find((l) => l.startsWith('Token cap')), 'Token cap: 100 weighted tokens per arm (200 total; cache reads count 0.1)');
  assert.ok(!r.logs.some((l) => l.startsWith('Approximate total cap')), 'no USD line without a budget');
  assert.equal(r.res.totalCapTokens, 200);
  assert.equal(r.withStream, chunks.slice(0, 3).join(''), 'the partial stream is kept and cut right after the line that reached the cap');
  assert.deepEqual(r.tmpLeft, []);
});

test('runMeasure: an arm that stays under --max-tokens is not killed and the row says no', async () => {
  const r = await runWith({ maxTokens: 1_000_000 });
  assert.deepEqual(r.calls.map((c) => c.killed), [0, 0]);
  assert.ok(r.md.includes('| stopped at token cap | no | no |'));
  assert.equal(r.res.arms.with.stoppedAtTokenCap, false);
});

test('runMeasure: a cap hit by a line that arrives without its newline still kills the arm', async () => {
  const r = await runWith({ maxTokens: 10 }, { chunks: [assistantLine('m1', 10).trimEnd()] });
  assert.deepEqual(r.calls.map((c) => c.killed), [1, 1]);
});

test('runMeasure: --max-tokens only passes no --max-budget-usd; --budget only still works; both apply together', async () => {
  const tokensOnly = await runWith({ maxTokens: 500 });
  for (const c of tokensOnly.calls) assert.ok(!c.args.includes('--max-budget-usd'));
  assert.ok(!tokensOnly.md.includes('--max-budget-usd'));
  assert.equal(tokensOnly.res.totalCapUsd, null);

  const budgetOnly = await runWith({ budgetUsd: 3 });
  for (const c of budgetOnly.calls) assert.equal(c.args[c.args.indexOf('--max-budget-usd') + 1], '3');
  assert.match(budgetOnly.logs[0], /^Approximate total cap: 6 USD/);
  assert.ok(!budgetOnly.logs.some((l) => l.startsWith('Token cap')));
  assert.equal(budgetOnly.res.totalCapTokens, null);

  const both = await runWith({ budgetUsd: 3, maxTokens: 500 });
  for (const c of both.calls) assert.equal(c.args[c.args.indexOf('--max-budget-usd') + 1], '3');
  assert.match(both.logs[0], /^Approximate total cap: 6 USD/);
  assert.ok(both.logs.includes('Token cap: 500 weighted tokens per arm (1000 total; cache reads count 0.1)'));
  assert.match(both.md, /Token cap: 500 weighted tokens per arm \(cache reads count 0\.1\)\. Budget cap: 3 USD per arm\./);
});

test('runMeasure: refuses with neither cap, or a bad --max-tokens, before cloning anything', async () => {
  const root = sandbox();
  try {
    const calls = [];
    const base = { repo: root, ref: 'x', prompt: 'p', model: 'sonnet', out: path.join(root, 'r.md'), spawn: fakeSpawn(calls), tmpRoot: root, log() {} };
    await assert.rejects(runMeasure({ ...base }), /at least one cap.*--max-tokens.*--budget/);
    await assert.rejects(runMeasure({ ...base, budgetUsd: undefined, maxTokens: undefined }), /at least one cap/);
    for (const maxTokens of [0, -5, 1.5, 'abc', Number.NaN, '100', Infinity]) await assert.rejects(runMeasure({ ...base, maxTokens }), /--max-tokens/, String(maxTokens));
    await assert.rejects(runMeasure({ ...base, maxTokens: 20_000_001 }), /--allow-high-budget/);
    await assert.rejects(runMeasure({ ...base, maxTokens: 500, budgetUsd: 0 }), /--budget/, 'a bad budget is refused even when a token cap is given');
    await assert.rejects(runMeasure({ ...base, maxTokens: 500, budgetUsd: 21 }), /--allow-high-budget/);
    assert.equal(calls.length, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    cleanup(root);
  }
});

test('runMeasure: above 20,000,000 tokens runs only with allowHighBudget; exactly 20,000,000 needs no flag', async () => {
  const high = await runWith({ maxTokens: 20_000_001, allowHighBudget: true });
  assert.equal(high.res.ok, true);
  const edge = await runWith({ maxTokens: 20_000_000 });
  assert.equal(edge.res.ok, true);
});

test('parseCli: --max-tokens and --setup are read; a flag given without a value is refused rather than ignored', () => {
  const root = sandbox();
  try {
    const pf = path.join(root, 'prompt.txt');
    writeFileSync(pf, 'p');
    const need = ['--repo', 'r', '--ref', 'abc', '--prompt-file', pf, '--out', 'o.md'];
    const o = parseCli([...need, '--max-tokens', '2000000', '--setup', 'npm ci']);
    assert.equal(o.maxTokens, 2000000);
    assert.equal(o.budgetUsd, undefined);
    assert.equal(o.setup, 'npm ci');
    assert.equal(parseCli([...need, '--max-tokens=15']).maxTokens, 15);
    assert.ok(Number.isNaN(parseCli([...need, '--max-tokens', 'abc']).maxTokens), 'garbage stays NaN so runMeasure refuses it');
    assert.equal(parseCli([...need, '--max-tokens', '1.5']).maxTokens, 1.5);
    assert.throws(() => parseCli([...need, '--budget', '3', '--max-tokens']), /--max-tokens needs a value/);
    assert.throws(() => parseCli([...need, '--max-tokens', '5', '--budget']), /--budget needs a value/);
    assert.throws(() => parseCli([...need, '--setup']), /--setup needs a value/);
  } finally {
    cleanup(root);
  }
});

function setupSeam(events, { code = 0, output = '', timedOut = false, delayMs = 0, perCwd } = {}) {
  const seen = [];
  const fn = async (command, cwd, timeoutMs) => {
    events.push('setup');
    seen.push({ command, cwd, timeoutMs, localConfig: existsSync(path.join(cwd, '.claude', 'nauraiz-dev.local.json')) });
    perCwd?.(cwd, seen.length - 1);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const exit = typeof code === 'function' ? code(seen.length - 1) : code;
    return { code: exit, output, timedOut };
  };
  fn.seen = seen;
  return fn;
}

test('--setup: runs once per clone, after the local config is written and before any claude spawn; its time is not the arm time', async () => {
  const events = [];
  const setupExec = setupSeam(events, {
    delayMs: 40, output: 'installed',
    perCwd: (cwd) => { mkdirSync(path.join(cwd, 'node_modules')); writeFileSync(path.join(cwd, 'node_modules', 'x.js'), '1'); },
  });
  const r = await runWith({ budgetUsd: 1, setup: 'npm ci', setupExec, timeoutMin: 7 }, { events });
  assert.deepEqual(events, ['setup', 'setup', 'spawn', 'spawn'], 'both clones are prepared before any money is spent');
  assert.equal(setupExec.seen.length, 2);
  assert.deepEqual(setupExec.seen.map((s) => s.command), ['npm ci', 'npm ci']);
  assert.deepEqual(setupExec.seen.map((s) => s.cwd), r.calls.map((c) => c.opts.cwd));
  assert.deepEqual(setupExec.seen.map((s) => s.timeoutMs), [420000, 420000], '--timeout-min is reused');
  assert.equal(setupExec.seen[0].localConfig, true, 'the with clone already has its local config');
  assert.equal(r.res.ok, true);
  assert.ok(r.md.includes('| time | 61.0 s | 61.0 s |'), 'arm time comes from the stream, not the wall clock');
  assert.match(r.md, /Setup \('npm ci', run in each clone before claude; its time and output are not part of the numbers\): ok \(with \d+\.\d s, without \d+\.\d s\)\./);
  assert.ok(r.md.includes('| files touched | none | none |'), 'files the setup created (node_modules) are not the arm work');
});

test('--setup: a failing setup marks the run FAILED, skips both arms (no claude, no gate) and cleans up', async () => {
  for (const failAt of [0, 1]) {
    const events = [];
    const setupExec = setupSeam(events, { code: (i) => (i === failAt ? 3 : 0), output: 'boom line' });
    const r = await runWith({ budgetUsd: 1, setup: 'npm ci', setupExec, gate: 'true' }, { events });
    assert.equal(r.res.ok, false, String(failAt));
    assert.equal(r.calls.length, 0, 'claude never started, nothing spent');
    assert.equal(r.gateCalls.length, 0);
    assert.match(r.res.failed, new RegExp(`setup failed in the ${failAt === 0 ? 'with' : 'without'} clone \\(exit 3\\)`));
    assert.ok(r.md.startsWith('**FAILED: setup failed'), r.md.slice(0, 120));
    assert.match(r.md, /: FAILED in the (with|without) clone/, 'the setup status is in the header');
    assert.ok(r.logs.some((l) => l.includes('boom line')), 'the tail of the setup output is logged');
    assert.deepEqual(r.tmpLeft, []);
    assert.equal(events.filter((e) => e === 'spawn').length, 0);
  }
});

test('--setup: a setup that times out is a failure', async () => {
  const r = await runWith({ budgetUsd: 1, setup: 'sleep', setupExec: setupSeam([], { code: 1, timedOut: true }), timeoutMin: 2 });
  assert.equal(r.res.ok, false);
  assert.match(r.res.failed, /setup timed out after 2 min in the with clone/);
  assert.equal(r.calls.length, 0);
});

test('--setup: the default executor runs the command through the shell in the clone, and kills it on timeout', { timeout: 30_000 }, async () => {
  const ok = await runWith({ budgetUsd: 1, setup: 'node -e "require(\'fs\').writeFileSync(\'setup-ran.txt\', \'x\')"' });
  assert.equal(ok.res.ok, true, ok.res.failed ?? '');
  assert.ok(ok.calls.every((c) => c.cwdFiles.includes('setup-ran.txt')), 'the file the setup wrote was there when claude started');
  assert.ok(ok.md.includes('| files touched | none | none |'));

  const slow = await runWith({ budgetUsd: 1, setup: 'node -e "setTimeout(() => {}, 60000)"', timeoutMin: 0.004 });
  assert.equal(slow.res.ok, false);
  assert.match(slow.res.failed, /setup timed out/);
  assert.equal(slow.calls.length, 0);
});

test('--setup: absent, nothing is run and the report has no setup line; a blank setup is refused', async () => {
  const events = [];
  const setupExec = setupSeam(events);
  const r = await runWith({ budgetUsd: 1, setupExec }, { events });
  assert.equal(setupExec.seen.length, 0);
  assert.ok(!r.md.includes('Setup ('));
  await assert.rejects(runWith({ budgetUsd: 1, setup: '   ' }), /--setup/);
});

test('--setup: a setupExec that rejects fails closed (setup failed, no claude, no gate)', async () => {
  const r = await runWith({ budgetUsd: 1, setup: 'npm ci', gate: 'true', setupExec: async () => { throw new Error('kaboom'); } });
  assert.equal(r.res.ok, false);
  assert.match(r.res.failed, /setup failed in the with clone \(exit 1\)/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.gateCalls.length, 0);
  assert.ok(r.logs.some((l) => l.includes('kaboom')));
});

test('--setup: the setup always runs inside the temp clones, never in the source repo', async () => {
  const setupExec = setupSeam([]);
  const r = await runWith({ budgetUsd: 1, setup: 'npm ci', setupExec });
  assert.equal(setupExec.seen.length, 2);
  for (const { cwd } of setupExec.seen) {
    assert.ok(path.resolve(cwd).startsWith(path.resolve(r.tmp) + path.sep), `${cwd} is under the temp root`);
    assert.notEqual(path.resolve(cwd), path.resolve(r.bare));
  }
  assert.ok(r.md.includes('Files the setup created or changed are not listed under files touched'));
  assert.match(r.md, /The --setup command runs in each clone with the full environment, outside the allowed-tools list \(package lifecycle scripts run\), and is killed after --timeout-min/);
});

test('shellSetupExec: a compound command whose grandchild outlives the kill still resolves as timed out (POSIX)', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const root = sandbox();
  try {
    const started = Date.now();
    const r = await shellSetupExec('sh -c "node -e \'setTimeout(()=>{},60000)\'; true"', root, 300);
    assert.equal(r.timedOut, true);
    assert.equal(r.code, 1);
    assert.ok(Date.now() - started < 10_000, 'resolved from the timer, not when the grandchild finally exits');
  } finally {
    cleanup(root);
  }
});

test('exitCodeFor: argument refusals are 2, anything else is 1', async () => {
  assert.equal(exitCodeFor(new UsageError('x')), 2);
  assert.equal(exitCodeFor(new Error('git clone failed')), 1);
  assert.equal(exitCodeFor(undefined), 1);
  const root = sandbox();
  try {
    const base = { repo: root, ref: 'x', prompt: 'p', out: path.join(root, 'r.md'), tmpRoot: root, log() {} };
    for (const bad of [{}, { maxTokens: 1.5 }, { budgetUsd: 3, timeoutMin: 0 }, { budgetUsd: 3, setup: ' ' }, { budgetUsd: 99 }, { budgetUsd: 3, prompt: '' }]) {
      await runMeasure({ ...base, ...bad }).then(() => assert.fail('should refuse'), (e) => assert.equal(exitCodeFor(e), 2, JSON.stringify(bad)));
    }
    await runMeasure({ ...base, budgetUsd: 3, ref: 'does-not-exist', repo: root }).then(() => assert.fail('should fail'), (e) => assert.equal(exitCodeFor(e), 1));
    assert.throws(() => parseCli(['--repo', 'r']), (e) => exitCodeFor(e) === 2);
    assert.throws(() => parseCli(['--repo', 'r', '--ref', 'x', '--out', 'o', '--prompt-file', path.join(root, 'missing.txt')]), (e) => /cannot read the prompt file/.test(e.message) && exitCodeFor(e) === 2);
  } finally {
    cleanup(root);
  }
});

test('POSIX kill path: arms spawn detached; the token cap and the timeout signal the process group (SIGTERM, then SIGKILL after 2 s)', { timeout: 20_000 }, async () => {
  const realKill = process.kill;
  const signals = [];
  process.kill = (p, sig) => { if (p < 0) { signals.push([p, sig]); return true; } return realKill.call(process, p, sig); };
  try {
    const chunks = [assistantLine('m1', 60), assistantLine('m2', 50), assistantLine('m3', 5000)];
    const capped = await runWith({ maxTokens: 100, platform: 'linux' }, { chunks, pid: 4242 });
    assert.ok(capped.calls.every((c) => c.opts.detached === true), 'POSIX arms run in their own process group');
    assert.deepEqual(capped.calls.map((c) => c.killed), [1, 1]);
    assert.ok(capped.md.includes('| stopped at token cap | yes | yes |'));
    const timedOut = await runWith({ budgetUsd: 1, timeoutMin: 0.001, platform: 'linux' }, { hang: true, pid: 4343 });
    assert.ok(timedOut.md.includes('killed after the 0.001 min timeout'));
    assert.deepEqual(signals.filter(([, s]) => s === 'SIGTERM'), [[-4242, 'SIGTERM'], [-4242, 'SIGTERM'], [-4343, 'SIGTERM'], [-4343, 'SIGTERM']]);
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(signals.filter(([p, s]) => s === 'SIGKILL' && p === -4242).length, 2, 'SIGKILL follows for each capped arm');
    assert.equal(signals.filter(([p, s]) => s === 'SIGKILL' && p === -4343).length, 2, 'SIGKILL follows for each timed-out arm');
  } finally {
    process.kill = realKill;
  }
});

test('win32 kill path: arms are not spawned detached', async () => {
  const r = await runWith({ budgetUsd: 1, platform: 'win32' });
  assert.ok(r.calls.every((c) => c.opts.detached === false));
});

const cacheLine = (id, cacheRead, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: extra.ts, message: { id, usage: { input_tokens: 0, output_tokens: 3, cache_read_input_tokens: cacheRead }, content: extra.content ?? [] } }) + '\n';

test('runMeasure: the cap counts weighted tokens; cache reads that would trip a raw cap do not, and the arm is killed once the weighted count reaches it', async () => {
  // each message: 3 output + 0.1 x 5,000 cache reads = 503 weighted (5,003 raw); the cap is 1,000
  const chunks = [cacheLine('m1', 5000), cacheLine('m2', 5000), cacheLine('m3', 5000)];
  const r = await runWith({ maxTokens: 1000 }, { chunks });
  assert.deepEqual(r.calls.map((c) => c.killed), [1, 1]);
  assert.equal(r.withStream, chunks.slice(0, 2).join(''), 'm1 = 503 weighted (under 1,000); m2 = 1,006 stops it');
  assert.match(r.logs.find((l) => /token cap reached/.test(l)), /1006 of 1000 weighted tokens/);
  const under = await runWith({ maxTokens: 1000 }, { chunks: [cacheLine('m1', 5000)] });
  assert.deepEqual(under.calls.map((c) => c.killed), [0, 0], '5,003 raw tokens against a 1,000 cap: not stopped, because the weighted count is 503');
});

test('runMeasure: a stopped arm with no result line gets estimated output and the time from the stream timestamps in its report', async () => {
  const text = (n) => [{ type: 'text', text: 'z'.repeat(n) }];
  const chunks = [
    cacheLine('m1', 1000, { ts: '2026-10-31T08:00:00.000Z', content: text(400) }),
    cacheLine('m2', 100_000, { ts: '2026-10-31T08:01:30.000Z', content: text(40) }),
    cacheLine('m3', 100_000, { ts: '2026-10-31T08:09:00.000Z' }),
  ];
  const r = await runWith({ maxTokens: 5000 }, { chunks });
  // stopped at m2: 100 + 10 estimated output, 101,000 cache reads
  assert.ok(r.md.includes('| output tokens | 110 (estimated) | 110 (estimated) |'), r.md);
  assert.ok(r.md.includes('| time | 90.0 s (from stream timestamps) | 90.0 s (from stream timestamps) |'), r.md);
  assert.ok(r.md.includes('| tokens (weighted: cache reads at 0.1) | 10210 (includes estimated output) | 10210 (includes estimated output) |'), r.md);
  assert.ok(r.md.includes('| tokens (raw) | 101110 (includes estimated output) | 101110 (includes estimated output) |'), r.md);
  assert.ok(r.md.includes('| stopped at token cap | yes | yes |'));
});

test('runMeasure: both arms get Skill, Agent, AskUserQuestion and TodoWrite in the same allowed-tools list', async () => {
  const r = await runWith({ budgetUsd: 1 });
  const lists = r.calls.map((c) => c.args[c.args.indexOf('--allowedTools') + 1]);
  assert.equal(lists[0], lists[1]);
  for (const t of ['Skill', 'Agent', 'AskUserQuestion', 'TodoWrite']) assert.ok(lists[0].split(' ').includes(t), t);
});
