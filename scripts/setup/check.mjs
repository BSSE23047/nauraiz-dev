#!/usr/bin/env node
// setup check: inspect a machine's Claude Code home and print what nauraiz-dev needs.
// Usage: node scripts/setup/check.mjs [--home <dir>] [--no-claude] [--no-update]
//   (env NAURAIZ_SKIP_CLAUDE=1 = --no-claude, NAURAIZ_SKIP_UPDATE=1 = --no-update)
// Never throws: unreadable or malformed files count as absent. Never changes anything.
// The CLI makes one network call (git ls-remote) to look for a newer release; --no-update skips it and
// an offline machine just reports "could not check". The session-start hook imports only superpowersStatus
// from here and never asks about updates.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/main.mjs';

const MARKETPLACE_REPO = 'BSSE23047/nauraiz-dev';
const OFFICIAL = 'claude-plugins-official';
const SUPERPOWERS_ID = `superpowers@${OFFICIAL}`;
const NAURAIZ_ID = 'nauraiz-dev@nauraiz-dev';
const RELEASES_URL = 'https://github.com/BSSE23047/nauraiz-dev.git';
const UPDATE_COMMAND = 'claude plugin marketplace update nauraiz-dev && claude plugin update nauraiz-dev@nauraiz-dev';
const UPDATE_NOTE = 'then start a new session; to get updates automatically, turn on auto-update for the nauraiz-dev marketplace in /plugin';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parsed JSON object, or null when missing, unreadable, unparsable or not an object. */
function readJsonObject(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** { version, ok } for a `process.version`-style string; ok means major >= 20. */
export function nodeStatus(version) {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  return { version, ok: Number.isFinite(major) && major >= 20 };
}

/** Output of `claude --version`, or null when the CLI is missing, slow or fails. */
function claudeVersion() {
  try {
    const options = { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] };
    // On Windows the CLI is a .cmd shim, which needs a shell; a fixed command string avoids passing args to it.
    const out = process.platform === 'win32'
      ? execFileSync('claude --version', { ...options, shell: true })
      : execFileSync('claude', ['--version'], options);
    return out.trim() || null;
  } catch {
    return null;
  }
}

const hasPlugin = (keys, name) => keys.some((k) => k.startsWith(`${name}@`));

/** Every hook command string under hooks.<event>[].hooks[].command that mentions nauraiz-dev. */
function duplicateHooks(settings) {
  const found = [];
  const events = isPlainObject(settings?.hooks) ? Object.values(settings.hooks) : [];
  for (const groups of events) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (isPlainObject(hook) && typeof hook.command === 'string' && hook.command.includes('nauraiz-dev')) {
          found.push(hook.command);
        }
      }
    }
  }
  return found;
}

/**
 * Compare two X.Y.Z versions (a leading v is ignored): -1 when a < b, 0 when equal, 1 when a > b.
 * A value that is not X.Y.Z compares as equal to everything, so callers decide before relying on it.
 */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a ?? '').replace(/^v/, ''));
  const pb = SEMVER.exec(String(b ?? '').replace(/^v/, ''));
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Default runner for git: never throws, returns { code, stdout, stderr } (code null when it could not run). */
function gitRunner(args) {
  const r = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) return { code: null, stdout: '', stderr: r.error.message };
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * The newest released version of the plugin: the highest `refs/tags/vX.Y.Z` on the public repo, found with
 * `git ls-remote --tags --refs`. `run(args)` is injectable and returns { code, stdout, stderr }.
 * Never throws: a failure, an empty answer or a runner that throws gives { version: null, reason }.
 */
export function latestRelease({ run = gitRunner } = {}) {
  let r;
  try {
    r = run(['ls-remote', '--tags', '--refs', RELEASES_URL]);
  } catch (e) {
    return { version: null, reason: `could not reach the release list: ${String(e?.message ?? e)}` };
  }
  if (!r || r.code !== 0) {
    const why = String(r?.stderr ?? '').trim().split(/\r?\n/)[0] || (r ? `exit ${r.code}` : 'no result');
    return { version: null, reason: `could not reach the release list: ${why}` };
  }
  let best = null;
  for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
    const m = /\trefs\/tags\/v(\d+\.\d+\.\d+)\s*$/.exec(line);
    if (m && (best === null || compareVersions(m[1], best) > 0)) best = m[1];
  }
  if (best === null) return { version: null, reason: 'the release list has no vX.Y.Z tags' };
  return { version: best, reason: 'ok' };
}

/** This plugin's own version from .claude-plugin/plugin.json (next to scripts/), or null when unreadable. */
export function installedVersion() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude-plugin', 'plugin.json');
    const v = JSON.parse(readFileSync(file, 'utf8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/** { installed, latest, behind, reason } from the installed version and a latestRelease() result (null = not asked). */
export function updateStatus(installed, release) {
  if (!release) return { installed, latest: null, behind: null, reason: 'not checked' };
  const latest = release.version ?? null;
  if (latest === null) return { installed, latest, behind: null, reason: `could not check for updates (${release.reason})` };
  if (!SEMVER.test(String(installed))) return { installed, latest, behind: null, reason: 'could not read the installed version' };
  const c = compareVersions(installed, latest);
  if (c < 0) return { installed, latest, behind: true, reason: `installed ${installed}, latest ${latest}; ${UPDATE_NOTE}` };
  return { installed, latest, behind: false, reason: c === 0 ? 'up to date' : `installed ${installed} is newer than the latest release ${latest}` };
}

/** Claude Code's config dir: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Whether superpowers is installed (user plugin registry) and enabled in the settings that apply to `cwd`:
 * `<home>/settings.json`, then `<cwd>/.claude/settings.json`, then `<cwd>/.claude/settings.local.json`.
 * A later file that mentions a superpowers key overrides an earlier one, so a project-scope enable counts
 * and a local `false` switches it off. Unreadable files count as absent.
 */
export function superpowersStatus({ cwd, home = claudeHome() }) {
  const installedMap = readJsonObject(path.join(home, 'plugins', 'installed_plugins.json'))?.plugins;
  const installed = hasPlugin(isPlainObject(installedMap) ? Object.keys(installedMap) : [], 'superpowers');
  let enabled = false;
  for (const file of [
    path.join(home, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ]) {
    const map = readJsonObject(file)?.enabledPlugins;
    if (!isPlainObject(map)) continue;
    const keys = Object.keys(map).filter((k) => k.startsWith('superpowers@'));
    if (keys.length) enabled = keys.some((k) => map[k] === true);
  }
  return { installed, enabled };
}

/**
 * Inspect `home` (default CLAUDE_CONFIG_DIR, else ~/.claude) and report the machine state plus the fixes to offer.
 * `skipClaude` skips running `claude --version`; `nodeVersion` is for tests.
 * `latest` is a function returning { version, reason } (use latestRelease); without it no network is touched
 * and `update.behind` is null. `version` overrides the installed version (tests).
 */
export function check({ home = claudeHome(), skipClaude = false, nodeVersion = process.version, latest = null, version = installedVersion() } = {}) {
  const settings = readJsonObject(path.join(home, 'settings.json')) ?? {};
  const installedMap = readJsonObject(path.join(home, 'plugins', 'installed_plugins.json'))?.plugins;
  const installedKeys = isPlainObject(installedMap) ? Object.keys(installedMap) : [];
  const enabledMap = isPlainObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const enabledKeys = Object.keys(enabledMap).filter((k) => enabledMap[k] === true);

  const plugin = (name) => ({ installed: hasPlugin(installedKeys, name), enabled: hasPlugin(enabledKeys, name) });
  const node = nodeStatus(nodeVersion);
  const claude = { version: skipClaude ? null : claudeVersion() };
  const superpowers = plugin('superpowers');
  const nauraizDev = plugin('nauraiz-dev');
  const autoMemory = settings.autoMemoryEnabled !== false;
  const duplicates = duplicateHooks(settings);
  const allowed = Array.isArray(settings.allowCrossMarketplaceDependenciesOn)
    && settings.allowCrossMarketplaceDependenciesOn.includes(OFFICIAL);

  const fixes = [];
  if (!node.ok) fixes.push('Install Node 20 or newer (https://nodejs.org), then run this check again.');
  if (!skipClaude && claude.version === null) fixes.push('Install Claude Code (npm install -g @anthropic-ai/claude-code), then run this check again.');
  if (!superpowers.installed) fixes.push(`claude plugin install ${SUPERPOWERS_ID}`);
  else if (!superpowers.enabled) fixes.push(`claude plugin enable ${SUPERPOWERS_ID}`);
  if (!nauraizDev.installed) fixes.push(`claude plugin marketplace add ${MARKETPLACE_REPO} && claude plugin install ${NAURAIZ_ID}`);
  else if (!nauraizDev.enabled) fixes.push(`claude plugin enable ${NAURAIZ_ID}`);
  for (const command of duplicates) {
    fixes.push(`Remove the nauraiz-dev hook from ~/.claude/settings.json; the plugin registers its own: ${command}`);
  }
  if (!allowed) {
    fixes.push(`Add "allowCrossMarketplaceDependenciesOn": ["${OFFICIAL}"] to ~/.claude/settings.json if installing nauraiz-dev reports a dependency error.`);
  }
  if (!autoMemory) fixes.push('Set "autoMemoryEnabled": true in ~/.claude/settings.json (it is currently false).');

  let release = null;
  if (typeof latest === 'function') {
    try {
      release = latest();
    } catch (e) {
      release = { version: null, reason: String(e?.message ?? e) };
    }
  }
  const update = updateStatus(version, release);
  if (update.behind === true) fixes.push(UPDATE_COMMAND);

  return {
    node,
    claude,
    superpowers,
    nauraizDev,
    autoMemory,
    userClaudeMd: isFile(path.join(home, 'CLAUDE.md')),
    duplicateHooks: duplicates,
    crossMarketplace: { allowed },
    update,
    fixes,
  };
}

if (isMain(import.meta.url)) {
  let out = '{}';
  try {
    const args = process.argv.slice(2);
    const at = args.indexOf('--home');
    const home = at !== -1 && args[at + 1] ? path.resolve(args[at + 1]) : undefined;
    const skipClaude = args.includes('--no-claude') || process.env.NAURAIZ_SKIP_CLAUDE === '1';
    const skipUpdate = args.includes('--no-update') || process.env.NAURAIZ_SKIP_UPDATE === '1';
    out = JSON.stringify(check({ home, skipClaude, latest: skipUpdate ? null : () => latestRelease() }), null, 2);
  } catch {
    // check never throws; this guards the argument handling only
  }
  process.stdout.write(`${out}\n`);
}
