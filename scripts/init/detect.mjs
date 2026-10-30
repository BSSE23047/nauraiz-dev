#!/usr/bin/env node
// init detection: read a repo's manifests and .claude/ folder and print what nauraiz-dev should configure.
// Usage: node scripts/init/detect.mjs [cwd]. Never throws: unreadable or malformed files count as absent.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/main.mjs';

const NODE_GATE = ['build', 'test', 'lint'];
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Text of a regular file, or null when it is missing, a directory or unreadable. */
function readText(file) {
  try {
    if (!statSync(file).isFile()) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Parsed JSON object, or null when missing, unparsable or not an object. */
function readJsonObject(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when a PreToolUse entry's matcher would see file edits (no matcher or `*` means every tool). */
function seesEdits(entry) {
  if (!isPlainObject(entry)) return false;
  const matcher = typeof entry.matcher === 'string' ? entry.matcher.trim() : '';
  if (!matcher || matcher === '*') return true;
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return EDIT_TOOLS.some((tool) => re.test(tool));
  } catch {
    return EDIT_TOOLS.some((tool) => matcher.includes(tool));
  }
}

function baseBranch(cwd) {
  try {
    const out = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      encoding: 'utf8',
    }).trim();
    const name = out.startsWith('origin/') ? out.slice('origin/'.length) : out;
    return name || 'main';
  } catch {
    return 'main';
  }
}

function countLines(text) {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * Detect the stack, gate commands, protected paths and existing setup of the repo at `cwd`.
 * Node (package.json) takes precedence over Flutter (pubspec.yaml) when both exist.
 */
export function detect(cwd) {
  const at = (...parts) => path.join(cwd, ...parts);
  const result = {
    stack: 'unknown',
    gate: {},
    protectedPaths: ['.env*'],
    existingPreToolUseHook: false,
    claudeMd: { exists: false, lines: 0 },
    hasState: false,
    hasWorkTasks: false,
    baseBranch: 'main',
  };

  try {
    const pkg = readJsonObject(at('package.json'));
    if (pkg) {
      result.stack = 'node';
      const scripts = isPlainObject(pkg.scripts) ? pkg.scripts : {};
      for (const name of NODE_GATE) {
        if (typeof scripts[name] === 'string' && scripts[name].trim()) result.gate[name] = `npm run ${name}`;
      }
    } else if (readText(at('pubspec.yaml')) !== null) {
      result.stack = 'flutter';
      result.gate = { analyze: 'flutter analyze', test: 'flutter test' };
    }

    const owned = readJsonObject(at('.claude', 'knowledge', 'protected-paths.json'))?.frameworkOwned;
    if (Array.isArray(owned)) {
      for (const p of owned) {
        if (typeof p === 'string' && p && !result.protectedPaths.includes(p)) result.protectedPaths.push(p);
      }
    }

    const preToolUse = readJsonObject(at('.claude', 'settings.json'))?.hooks?.PreToolUse;
    result.existingPreToolUseHook = Array.isArray(preToolUse) && preToolUse.some(seesEdits);

    const claudeMd = readText(at('CLAUDE.md'));
    if (claudeMd !== null) result.claudeMd = { exists: true, lines: countLines(claudeMd) };

    result.hasState = isDir(at('.claude', 'state'));
    result.hasWorkTasks = isDir(at('.work', 'tasks'));
    result.baseBranch = existsSync(cwd) ? baseBranch(cwd) : 'main';
  } catch {
    // keep whatever was detected before the failure
  }
  return result;
}

if (isMain(import.meta.url)) {
  let out = '{}';
  try {
    out = JSON.stringify(detect(path.resolve(process.argv[2] || process.cwd())), null, 2);
  } catch {
    // detect never throws; this guards the argument handling only
  }
  process.stdout.write(`${out}\n`);
}
