import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, claudeHome, compareVersions, installedVersion, latestRelease, nodeStatus, superpowersStatus } from '../scripts/setup/check.mjs';
import { forbiddenPattern } from './forbidden.mjs';

const FORBIDDEN = forbiddenPattern();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureHome = path.join(root, 'tests', 'fixtures', 'home');
const script = path.join(root, 'scripts', 'setup', 'check.mjs');

const SP_INSTALL = 'claude plugin install superpowers@claude-plugins-official';
const SP_ENABLE = 'claude plugin enable superpowers@claude-plugins-official';
const ND_INSTALL = 'claude plugin marketplace add BSSE23047/nauraiz-dev && claude plugin install nauraiz-dev@nauraiz-dev';
const ND_ENABLE = 'claude plugin enable nauraiz-dev@nauraiz-dev';
const CROSS = 'Add "allowCrossMarketplaceDependenciesOn": ["claude-plugins-official"] to ~/.claude/settings.json if installing nauraiz-dev reports a dependency error.';
const MEMORY = 'Set "autoMemoryEnabled": true in ~/.claude/settings.json (it is currently false).';

/** A throwaway home dir; `settings`/`installed` are JSON values or raw strings. */
function tempHome({ settings, installed, claudeMd } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nd-home-'));
  const put = (rel, v) => {
    mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    writeFileSync(path.join(home, rel), typeof v === 'string' ? v : JSON.stringify(v));
  };
  if (settings !== undefined) put('settings.json', settings);
  if (installed !== undefined) put('plugins/installed_plugins.json', { version: 2, plugins: installed });
  if (claudeMd !== undefined) put('CLAUDE.md', claudeMd);
  return home;
}
const withHome = (opts, fn) => {
  const home = tempHome(opts);
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
};
const run = (home) => check({ home, skipClaude: true });
const entry = [{ scope: 'user', version: '1.0.0' }];

test('fixture home: superpowers ok, nauraiz-dev missing, duplicate hook found', () => {
  const r = run(fixtureHome);
  assert.deepEqual(r.superpowers, { installed: true, enabled: true });
  assert.deepEqual(r.nauraizDev, { installed: false, enabled: false });
  assert.deepEqual(r.claude, { version: null });
  assert.equal(r.node.ok, true);
  assert.equal(r.autoMemory, true);
  assert.equal(r.userClaudeMd, false);
  assert.deepEqual(r.duplicateHooks, ['node "/opt/tools/nauraiz-dev/scripts/hooks/stop.mjs"']);
  assert.deepEqual(r.crossMarketplace, { allowed: false });
  assert.deepEqual(r.fixes, [
    ND_INSTALL,
    'Remove the nauraiz-dev hook from ~/.claude/settings.json; the plugin registers its own: node "/opt/tools/nauraiz-dev/scripts/hooks/stop.mjs"',
    CROSS,
  ]);
});

test('fully set up home has no fixes', () => withHome({
  settings: {
    enabledPlugins: { 'superpowers@claude-plugins-official': true, 'nauraiz-dev@nauraiz-dev': true },
    allowCrossMarketplaceDependenciesOn: ['claude-plugins-official'],
  },
  installed: { 'superpowers@claude-plugins-official': entry, 'nauraiz-dev@nauraiz-dev': entry },
  claudeMd: '# me\n',
}, (home) => {
  const r = run(home);
  assert.deepEqual(r.fixes, []);
  assert.deepEqual(r.crossMarketplace, { allowed: true });
  assert.equal(r.userClaudeMd, true);
  assert.deepEqual(r.duplicateHooks, []);
}));

test('missing home: everything absent, fix order is superpowers, nauraiz-dev, cross-marketplace', () => {
  const r = run(path.join(os.tmpdir(), `nd-no-such-home-${process.pid}`));
  assert.deepEqual(r.superpowers, { installed: false, enabled: false });
  assert.equal(r.autoMemory, true);
  assert.deepEqual(r.fixes, [SP_INSTALL, ND_INSTALL, CROSS]);
});

test('installed but disabled gets an enable fix, not an install fix', () => withHome({
  settings: {
    enabledPlugins: { 'superpowers@claude-plugins-official': false, 'nauraiz-dev@nauraiz-dev': false },
    allowCrossMarketplaceDependenciesOn: ['claude-plugins-official'],
  },
  installed: { 'superpowers@claude-plugins-official': entry, 'nauraiz-dev@nauraiz-dev': entry },
}, (home) => {
  const r = run(home);
  assert.deepEqual(r.superpowers, { installed: true, enabled: false });
  assert.deepEqual(r.nauraizDev, { installed: true, enabled: false });
  assert.deepEqual(r.fixes, [SP_ENABLE, ND_ENABLE]);
}));

test('a plugin is matched by name before the @, from any marketplace; any true key enables it', () => withHome({
  settings: { enabledPlugins: { 'superpowers@fork': false, 'superpowers@claude-plugins-official': true, 'superpowers-extras@x': true } },
  installed: { 'superpowers@fork': entry },
}, (home) => {
  assert.deepEqual(run(home).superpowers, { installed: true, enabled: true });
}));

test('a similarly named plugin does not count', () => withHome({
  settings: { enabledPlugins: { 'superpowers-extras@x': true } },
  installed: { 'superpowers-extras@x': entry },
}, (home) => {
  assert.deepEqual(run(home).superpowers, { installed: false, enabled: false });
}));

test('autoMemoryEnabled false is reported with a fix; other values count as on', () => {
  withHome({ settings: { autoMemoryEnabled: false } }, (home) => {
    const r = run(home);
    assert.equal(r.autoMemory, false);
    assert.equal(r.fixes.at(-1), MEMORY);
  });
  withHome({ settings: { autoMemoryEnabled: true } }, (home) => assert.equal(run(home).autoMemory, true));
});

test('crossMarketplace needs claude-plugins-official in an array', () => {
  for (const [value, allowed] of [[['other', 'claude-plugins-official'], true], [['other'], false], ['claude-plugins-official', false]]) {
    withHome({ settings: { allowCrossMarketplaceDependenciesOn: value } }, (home) => {
      const r = run(home);
      assert.equal(r.crossMarketplace.allowed, allowed);
      assert.equal(r.fixes.includes(CROSS), !allowed);
    });
  }
});

test('hooks: every command mentioning nauraiz-dev is found, others and malformed entries are ignored', () => withHome({
  settings: {
    hooks: {
      PreToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'node "/a/nauraiz-dev/x.mjs"' }, { type: 'command' }, null, 'junk'] },
        'junk',
        { hooks: 'junk' },
      ],
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "/b/nauraiz-dev/y.mjs"' }, { type: 'command', command: 'echo hi' }] }],
      Broken: 'junk',
    },
  },
}, (home) => {
  assert.deepEqual(run(home).duplicateHooks, ['node "/a/nauraiz-dev/x.mjs"', 'node "/b/nauraiz-dev/y.mjs"']);
}));

test('garbled or wrong-shaped files count as absent and never throw', () => {
  for (const settings of ['{ nope', '[]', 'null', { enabledPlugins: [], hooks: 5 }]) {
    withHome({ settings }, (home) => {
      const r = run(home);
      assert.deepEqual(r.superpowers, { installed: false, enabled: false });
      assert.deepEqual(r.duplicateHooks, []);
      assert.equal(r.autoMemory, true);
    });
  }
  for (const installed of ['garbage', '{"plugins":[1]}', '[]']) {
    const home = tempHome({ settings: '{}' });
    try {
      mkdirSync(path.join(home, 'plugins'), { recursive: true });
      writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), installed);
      assert.equal(run(home).superpowers.installed, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('nodeStatus: ok from major 20', () => {
  assert.deepEqual(nodeStatus('v20.0.0'), { version: 'v20.0.0', ok: true });
  assert.equal(nodeStatus('v24.1.0').ok, true);
  assert.equal(nodeStatus('v18.19.0').ok, false);
  assert.equal(nodeStatus('garbage').ok, false);
  assert.equal(run(fixtureHome).node.version, process.version);
});

test('node below 20 puts an install line first', () => {
  const r = check({ home: fixtureHome, skipClaude: true, nodeVersion: 'v18.0.0' });
  assert.equal(r.node.ok, false);
  assert.match(r.fixes[0], /^Install Node 20 or newer/);
});

test('CLI: --home and --no-claude print the JSON; NAURAIZ_SKIP_CLAUDE=1 also skips claude', () => {
  const out = execFileSync(process.execPath, [script, '--home', fixtureHome, '--no-claude', '--no-update'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), run(fixtureHome));
  const env = { ...process.env, NAURAIZ_SKIP_CLAUDE: '1', NAURAIZ_SKIP_UPDATE: '1' };
  const out2 = execFileSync(process.execPath, [script, '--home', fixtureHome], { encoding: 'utf8', env });
  assert.deepEqual(JSON.parse(out2).claude, { version: null });
});

test('claude not on PATH: version null and an install line comes first', () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'nd-path-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path' && k !== 'NAURAIZ_SKIP_CLAUDE'));
    env.PATH = empty;
    const out = execFileSync(process.execPath, [script, '--home', fixtureHome, '--no-update'], { encoding: 'utf8', env });
    const r = JSON.parse(out);
    assert.deepEqual(r.claude, { version: null });
    assert.match(r.fixes[0], /^Install Claude Code/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('user CLAUDE.md template: at most 25 lines, placeholders, no client or personal material', () => {
  const text = readFileSync(path.join(root, 'templates', 'user-CLAUDE.md'), 'utf8');
  assert.ok(text.replace(/\n$/, '').split('\n').length <= 25);
  for (const p of ['name', 'email', 'defaultModel', 'reviewStyle', 'aboutMe']) assert.ok(text.includes(`{{${p}}}`), p);
  assert.doesNotMatch(text, /@(?!\S*\{\{)\S+\.\S+/);
  if (FORBIDDEN) assert.doesNotMatch(text, FORBIDDEN);
});

test('setup skill frontmatter, and no client material in the setup files', () => {
  const text = readFileSync(path.join(root, 'skills', 'setup', 'SKILL.md'), 'utf8');
  const fm = text.split('---\n')[1];
  assert.match(fm, /^name: setup$/m);
  assert.ok(/^description: "(.*)"$/m.exec(fm)[1].length <= 1024);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(fm, /^allowed-tools: Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/setup\/check\.mjs" \*\) Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/show\.mjs" \*\) Read Write$/m);
  assert.doesNotMatch(fm, /\bEdit\b/);
  const files = ['skills/setup/SKILL.md', 'scripts/setup/check.mjs', 'templates/user-CLAUDE.md', 'tests/fixtures/home/settings.json', 'tests/fixtures/home/plugins/installed_plugins.json'];
  for (const f of files) {
    if (FORBIDDEN) assert.doesNotMatch(readFileSync(path.join(root, f), 'utf8'), FORBIDDEN, f);
  }
});

/** A throwaway home plus project dir for superpowersStatus; files are JSON values keyed by relative path. */
function withHomeAndCwd({ home: homeFiles = {}, cwd: cwdFiles = {} }, fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'nd-sp-home-'));
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'nd-sp-cwd-'));
  const put = (base, rel, v) => {
    mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    writeFileSync(path.join(base, rel), JSON.stringify(v));
  };
  try {
    for (const [rel, v] of Object.entries(homeFiles)) put(home, rel, v);
    for (const [rel, v] of Object.entries(cwdFiles)) put(cwd, rel, v);
    return fn({ home, cwd });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}
const SP = 'superpowers@claude-plugins-official';
const installedFile = { 'plugins/installed_plugins.json': { version: 2, plugins: { [SP]: entry } } };

test('superpowersStatus: enabled in user settings', () => withHomeAndCwd({
  home: { ...installedFile, 'settings.json': { enabledPlugins: { [SP]: true } } },
}, ({ home, cwd }) => {
  assert.deepEqual(superpowersStatus({ cwd, home }), { installed: true, enabled: true });
}));

test('superpowersStatus: a project-scope enable counts', () => withHomeAndCwd({
  home: { ...installedFile, 'settings.json': {} },
  cwd: { '.claude/settings.json': { enabledPlugins: { [SP]: true } } },
}, ({ home, cwd }) => {
  assert.deepEqual(superpowersStatus({ cwd, home }), { installed: true, enabled: true });
}));

test('superpowersStatus: settings.local.json false overrides an earlier true', () => withHomeAndCwd({
  home: { ...installedFile, 'settings.json': { enabledPlugins: { [SP]: true } } },
  cwd: {
    '.claude/settings.json': { enabledPlugins: { [SP]: true } },
    '.claude/settings.local.json': { enabledPlugins: { [SP]: false } },
  },
}, ({ home, cwd }) => {
  assert.deepEqual(superpowersStatus({ cwd, home }), { installed: true, enabled: false });
}));

test('superpowersStatus: a later true re-enables what an earlier file disabled', () => withHomeAndCwd({
  home: { ...installedFile, 'settings.json': { enabledPlugins: { [SP]: false } } },
  cwd: { '.claude/settings.json': { enabledPlugins: { [SP]: true } } },
}, ({ home, cwd }) => {
  assert.deepEqual(superpowersStatus({ cwd, home }), { installed: true, enabled: true });
}));

test('superpowersStatus: not installed, other plugins and missing files are false', () => {
  withHomeAndCwd({
    home: { 'settings.json': { enabledPlugins: { 'superpowers-extras@x': true } } },
  }, ({ home, cwd }) => {
    assert.deepEqual(superpowersStatus({ cwd, home }), { installed: false, enabled: false });
  });
  withHomeAndCwd({}, ({ home, cwd }) => {
    assert.deepEqual(superpowersStatus({ cwd, home }), { installed: false, enabled: false });
  });
});

test('superpowersStatus and check default to CLAUDE_CONFIG_DIR when it is set', () => withHomeAndCwd({
  home: { ...installedFile, 'settings.json': { enabledPlugins: { [SP]: true } } },
}, ({ home, cwd }) => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    assert.deepEqual(superpowersStatus({ cwd }), { installed: true, enabled: true });
    assert.equal(claudeHome(), home);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
  assert.equal(claudeHome({}), path.join(os.homedir(), '.claude'));
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '' }), path.join(os.homedir(), '.claude'));
}));

// ---- 0.2.5: update check ----

const lsRemote = (...tags) => tags.map((t, i) => `${String(i).padStart(40, 'a')}\trefs/tags/${t}`).join('\n') + '\n';
const okRun = (stdout) => () => ({ code: 0, stdout, stderr: '' });
const UPDATE_FIX = 'claude plugin marketplace update nauraiz-dev && claude plugin update nauraiz-dev@nauraiz-dev';

test('compareVersions: numeric per part, so 0.2.10 > 0.2.9; leading v ignored', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('0.2.9', '0.2.10'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.2.5', '0.2.5'), 0);
  assert.equal(compareVersions('v0.3.0', '0.2.9'), 1);
  assert.equal(compareVersions('garbage', '0.2.9'), 0);
});

test('latestRelease: parses refs/tags/vX.Y.Z and picks the highest, not the last or the lexical one', () => {
  const calls = [];
  const run = (args) => { calls.push(args); return { code: 0, stdout: lsRemote('v0.2.9', 'v0.2.10', 'v0.1.0', 'v0.2.2'), stderr: '' }; };
  assert.deepEqual(latestRelease({ run }), { version: '0.2.10', reason: 'ok' });
  assert.deepEqual(calls, [['ls-remote', '--tags', '--refs', 'https://github.com/BSSE23047/nauraiz-dev.git']]);
});

test('latestRelease: ignores tags that are not vX.Y.Z', () => {
  const out = lsRemote('v0.3.0-rc1', 'nightly', 'v1', '0.9.9', 'v0.2.4', 'release/v5.0.0');
  assert.deepEqual(latestRelease({ run: okRun(out) }), { version: '0.2.4', reason: 'ok' });
});

test('latestRelease: no tags, or none that parse, gives null with a reason', () => {
  for (const out of ['', '\n', lsRemote('nightly', 'v1')]) {
    const r = latestRelease({ run: okRun(out) });
    assert.equal(r.version, null);
    assert.match(r.reason, /no vX\.Y\.Z tags/);
  }
});

test('latestRelease: a failing, throwing or odd runner gives null with a reason and never throws', () => {
  const failed = latestRelease({ run: () => ({ code: 128, stdout: '', stderr: 'fatal: unable to access\nmore' }) });
  assert.equal(failed.version, null);
  assert.match(failed.reason, /could not reach the release list: fatal: unable to access$/);
  assert.equal(latestRelease({ run: () => ({ code: null, stdout: '', stderr: 'spawn git ENOENT' }) }).version, null);
  const thrown = latestRelease({ run: () => { throw new Error('boom'); } });
  assert.equal(thrown.version, null);
  assert.match(thrown.reason, /boom/);
  assert.equal(latestRelease({ run: () => null }).version, null);
  assert.equal(latestRelease({ run: () => ({ code: 0, stdout: undefined }) }).version, null);
});

test('installedVersion is the plugin.json version', () => {
  const plugin = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(installedVersion(), plugin.version);
  assert.equal(check({ home: fixtureHome, skipClaude: true }).update.installed, plugin.version);
});

test('check without a latest runner touches no network: behind null, no update fix', () => {
  const r = check({ home: fixtureHome, skipClaude: true, version: '0.2.0' });
  assert.deepEqual(r.update, { installed: '0.2.0', latest: null, behind: null, reason: 'not checked' });
  assert.ok(!r.fixes.includes(UPDATE_FIX));
});

test('update: behind adds the fix line last and a reason with the note', () => {
  const r = check({ home: fixtureHome, skipClaude: true, version: '0.2.4', latest: () => latestRelease({ run: okRun(lsRemote('v0.2.5', 'v0.2.10')) }) });
  assert.equal(r.update.installed, '0.2.4');
  assert.equal(r.update.latest, '0.2.10');
  assert.equal(r.update.behind, true);
  assert.match(r.update.reason, /then start a new session; to get updates automatically, turn on auto-update for the nauraiz-dev marketplace in \/plugin/);
  assert.equal(r.fixes.at(-1), UPDATE_FIX);
});

test('update: up to date, and ahead of the newest tag, are behind false with no fix', () => {
  const same = check({ home: fixtureHome, skipClaude: true, version: '0.2.5', latest: () => latestRelease({ run: okRun(lsRemote('v0.2.5')) }) });
  assert.deepEqual(same.update, { installed: '0.2.5', latest: '0.2.5', behind: false, reason: 'up to date' });
  assert.ok(!same.fixes.includes(UPDATE_FIX));
  const ahead = check({ home: fixtureHome, skipClaude: true, version: '0.3.0', latest: () => latestRelease({ run: okRun(lsRemote('v0.2.5')) }) });
  assert.equal(ahead.update.behind, false);
  assert.match(ahead.update.reason, /newer than the latest release/);
  assert.ok(!ahead.fixes.includes(UPDATE_FIX));
});

test('update: runner failure or no tags is behind null with a reason, and the check still works', () => {
  const failing = check({ home: fixtureHome, skipClaude: true, version: '0.2.4', latest: () => latestRelease({ run: () => ({ code: null, stdout: '', stderr: 'offline' }) }) });
  assert.equal(failing.update.behind, null);
  assert.equal(failing.update.latest, null);
  assert.match(failing.update.reason, /could not check for updates .*offline/);
  assert.ok(!failing.fixes.includes(UPDATE_FIX));
  const none = check({ home: fixtureHome, skipClaude: true, version: '0.2.4', latest: () => latestRelease({ run: okRun('') }) });
  assert.equal(none.update.behind, null);
  const throwing = check({ home: fixtureHome, skipClaude: true, version: '0.2.4', latest: () => { throw new Error('x'); } });
  assert.equal(throwing.update.behind, null);
  const unreadable = check({ home: fixtureHome, skipClaude: true, version: null, latest: () => ({ version: '0.2.5', reason: 'ok' }) });
  assert.equal(unreadable.update.behind, null);
});

test('session start never asks for updates: no hook or shared lib mentions latestRelease or ls-remote', () => {
  for (const dir of ['scripts/hooks', 'scripts/lib']) {
    for (const name of readdirSync(path.join(root, dir))) {
      const text = readFileSync(path.join(root, dir, name), 'utf8');
      assert.doesNotMatch(text, /latestRelease|ls-remote|updateStatus/, `${dir}/${name}`);
    }
  }
  const hook = readFileSync(path.join(root, 'scripts', 'hooks', 'session-start.mjs'), 'utf8');
  assert.deepEqual([...hook.matchAll(/import \{([^}]*)\} from '\.\.\/setup\/check\.mjs'/g)].map((m) => m[1].trim()), ['superpowersStatus']);
});

test('setup skill reports the update line', () => {
  const body = readFileSync(path.join(root, 'skills', 'setup', 'SKILL.md'), 'utf8');
  for (const needle of ['update.behind', 'up to date', 'could not check', 'claude plugin marketplace update nauraiz-dev']) assert.ok(body.includes(needle), needle);
});
