#!/usr/bin/env node
// setup check: inspect a machine's Claude Code home and print what nauraiz-dev needs.
// Usage: node scripts/setup/check.mjs [--home <dir>] [--no-claude]  (env NAURAIZ_SKIP_CLAUDE=1 = --no-claude)
// Never throws: unreadable or malformed files count as absent. Never changes anything.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from '../lib/main.mjs';

const MARKETPLACE_REPO = 'BSSE23047/nauraiz-dev';
const OFFICIAL = 'claude-plugins-official';
const SUPERPOWERS_ID = `superpowers@${OFFICIAL}`;
const NAURAIZ_ID = 'nauraiz-dev@nauraiz-dev';

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
 * Inspect `home` (default ~/.claude) and report the machine state plus the fixes to offer.
 * `skipClaude` skips running `claude --version`; `nodeVersion` is for tests.
 */
export function check({ home = path.join(os.homedir(), '.claude'), skipClaude = false, nodeVersion = process.version } = {}) {
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

  return {
    node,
    claude,
    superpowers,
    nauraizDev,
    autoMemory,
    userClaudeMd: isFile(path.join(home, 'CLAUDE.md')),
    duplicateHooks: duplicates,
    crossMarketplace: { allowed },
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
    out = JSON.stringify(check({ home, skipClaude }), null, 2);
  } catch {
    // check never throws; this guards the argument handling only
  }
  process.stdout.write(`${out}\n`);
}
