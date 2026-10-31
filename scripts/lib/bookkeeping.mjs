import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { matchesAny, normalize, toRelative } from './paths.mjs';

/**
 * Bookkeeping files: what the handoff writes, not the work itself. Edits to them never count as
 * "work since the gate/handoff" (Stop, PreCompact) and never trigger the plan-scope ask (PreToolUse).
 * The one list: `.claude/state/**`, `.work/handoff.md`, `<plan.dir>/**`, `.git/**`, and (with `cwd`)
 * the repository's git dir and common dir when git places them inside the project.
 */
function planDirPattern(config, cwd) {
  const dir = config?.plan?.dir;
  if (typeof dir !== 'string' || !dir.trim()) return null;
  const rel = typeof cwd === 'string' && cwd ? toRelative(cwd, dir) : normalize(dir);
  const outside = rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel);
  return outside ? null : `/${rel}/`;
}

const gitDirCache = new Map();

/** `/<rel>/` patterns for the git dir and common dir of `cwd` that lie inside it; [] outside a repo. Cached per cwd. */
function gitDirPatterns(cwd) {
  if (typeof cwd !== 'string' || !cwd) return [];
  if (gitDirCache.has(cwd)) return gitDirCache.get(cwd);
  const out = [];
  try {
    const lines = execFileSync('git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, encoding: 'utf8',
    }).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const rel = toRelative(cwd, path.resolve(cwd, line));
      const outside = rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel);
      if (!outside && !out.includes(`/${rel}/`)) out.push(`/${rel}/`);
    }
  } catch {
    // not a repo, or git missing: only the literal .git/ applies
  }
  gitDirCache.set(cwd, out);
  return out;
}

function patterns(config, cwd) {
  const out = ['/.claude/state/', '/.work/handoff.md', '/.git/'];
  const planPattern = planDirPattern(config, cwd);
  if (planPattern) out.push(planPattern);
  return out;
}

/** True when `rel` (relative to the project root) is under `config.plan.dir`; a dir outside the project never matches. */
export function isUnderPlanDir(rel, config, cwd) {
  if (typeof rel !== 'string' || !rel) return false;
  const planPattern = planDirPattern(config, cwd);
  return planPattern !== null && matchesAny(rel, [planPattern]);
}

/** True when `rel` (a path relative to the project root, as toRelative gives it) is a bookkeeping file. */
export function isBookkeeping(rel, config, cwd) {
  if (typeof rel !== 'string' || !rel) return false;
  if (matchesAny(rel, patterns(config, cwd))) return true;
  const gitDirs = gitDirPatterns(cwd);
  return gitDirs.length > 0 && matchesAny(rel, gitDirs);
}
