import { matchesAny, normalize, toRelative } from './paths.mjs';

/**
 * Bookkeeping files: what the handoff writes, not the work itself. Edits to them never count as
 * "work since the gate/handoff" (Stop, PreCompact) and never trigger the plan-scope ask (PreToolUse).
 * The one list: `.claude/state/**`, `.work/handoff.md`, and `<plan.dir>/**`.
 */
function patterns(config, cwd) {
  const out = ['/.claude/state/', '/.work/handoff.md'];
  const dir = config?.plan?.dir;
  if (typeof dir === 'string' && dir.trim()) {
    const rel = typeof cwd === 'string' && cwd ? toRelative(cwd, dir) : normalize(dir);
    const outside = rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel);
    if (!outside) out.push(`/${rel}/`);
  }
  return out;
}

/** True when `rel` (a path relative to the project root, as toRelative gives it) is a bookkeeping file. */
export function isBookkeeping(rel, config, cwd) {
  if (typeof rel !== 'string' || !rel) return false;
  return matchesAny(rel, patterns(config, cwd));
}
