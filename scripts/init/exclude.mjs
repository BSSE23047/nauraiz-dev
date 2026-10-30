#!/usr/bin/env node
// Local mode keeps nauraiz-dev's files out of git without touching any tracked file: it appends
// them to <git-common-dir>/info/exclude, which is per clone and shared by every worktree.
// Usage: node scripts/init/exclude.mjs <pattern>...  (patterns relative to the current folder)
// Prints { file, added } as JSON; exits 1 with a message outside a git repo.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/main.mjs';
import { normalize } from '../lib/paths.mjs';

const MARKER = '# nauraiz-dev (local mode)';

/** Default git runner: { code, stdout, stderr } for `git <args>` in `cwd`; never throws. */
function gitRunner(cwd) {
  return (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
  };
}

/** Make a folder prefix literal in a gitignore line: backslash-escape a leading # or ! and the glob characters. */
function escapePrefix(p) {
  return p.replace(/[*?[\\]/g, '\\$&').replace(/^[#!]/, '\\$&');
}

function gitOut(run, args) {
  const r = run(args);
  if (r.code !== 0) throw new Error(`nauraiz-dev: not a git repository (git ${args.join(' ')}: ${String(r.stderr).trim() || `exit ${r.code}`})`);
  return String(r.stdout).replace(/\r?\n$/, '');
}

/**
 * Append `patterns` (posix, relative to `cwd`) to the repository's info/exclude as repo-root-relative
 * lines under a marker. Only lines not already present are added. `run(args)` is an injectable git
 * runner returning { code, stdout, stderr }. Throws outside a git repo, before writing anything.
 */
export function addExcludes(cwd, patterns, run = gitRunner(cwd)) {
  const prefix = gitOut(run, ['rev-parse', '--show-prefix']);
  const common = gitOut(run, ['rev-parse', '--git-common-dir']);
  const file = path.resolve(cwd, common, 'info', 'exclude');

  const wanted = [];
  for (const p of patterns) {
    const rel = normalize(String(p));
    if (!rel) continue;
    const line = `${prefix ? `${escapePrefix(normalize(prefix))}/` : ''}${rel}`;
    if (!wanted.includes(line)) wanted.push(line);
  }

  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const added = wanted.filter((l) => !have.has(l));
  if (added.length) {
    const head = existing && !existing.endsWith('\n') ? '\n' : '';
    const marker = have.has(MARKER) ? '' : `${MARKER}\n`;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${existing}${head}${marker}${added.join('\n')}\n`);
  }
  return { file, added };
}

if (isMain(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(addExcludes(process.cwd(), process.argv.slice(2)))}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}
