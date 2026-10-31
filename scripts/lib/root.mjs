import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { realPath } from './paths.mjs';

/** The git top-level of `cwd`, or null when it is not in a repo or git cannot run. */
export function gitTopLevel(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const top = r.error || r.status !== 0 ? '' : String(r.stdout ?? '').trim();
  return top || null;
}

const sameDir = (a, b) => {
  const x = realPath(a) ?? path.resolve(a);
  const y = realPath(b) ?? path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const hasConfig = (dir) => ['nauraiz-dev.json', 'nauraiz-dev.local.json'].some((f) => existsSync(path.join(dir, '.claude', f)));

/**
 * The project root for a run started in `start`: the nearest directory at or above it that has
 * `.claude/nauraiz-dev.json` or `.claude/nauraiz-dev.local.json`. The walk stops after the git
 * top-level (so a config in a parent repo is never picked up), after any directory that has a `.git`
 * entry (for when git cannot report the top-level), or at the filesystem root. A directory's config
 * is checked before the stop. No config found: `start` itself. `gitTop(dir)` returns the git
 * top-level or null (injectable).
 */
export function findProjectRoot(start, gitTop = gitTopLevel) {
  const from = path.resolve(start);
  let top = null;
  try { top = gitTop(from); } catch { top = null; }
  let dir = from;
  for (;;) {
    if (hasConfig(dir)) return dir;
    if (existsSync(path.join(dir, '.git'))) break;
    if (top && sameDir(dir, top)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}
