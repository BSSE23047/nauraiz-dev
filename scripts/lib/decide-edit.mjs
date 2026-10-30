import { toRelative, matchesAny } from './paths.mjs';
import { isBookkeeping } from './bookkeeping.mjs';

const ALLOW = Object.freeze({ decision: 'allow', reason: '' });

/**
 * Decide whether an edit to `filePath` may proceed. Pure: `plan` is already resolved by the caller.
 * No config, or enforcement advisory (context only, spec 6.6) -> allow. Protected path -> deny.
 * Outside the plan's Allowed list -> ask (not when `config.scopeAsk === false`, which init sets when the
 * project already has its own PreToolUse edit hook), except for bookkeeping files (the plan dir,
 * .claude/state/**, .work/handoff.md), which are never asked about. Anything else -> allow.
 */
export function decideEdit({ cwd, filePath, config, found, plan }) {
  if (!found || !config || config.enforcement === 'advisory') return ALLOW;
  const rel = toRelative(cwd, filePath);

  const protectedPaths = (Array.isArray(config.protectedPaths) ? config.protectedPaths : [])
    .filter((p) => typeof p === 'string' && p);
  const hit = protectedPaths.find((pattern) => matchesAny(rel, [pattern]));
  if (hit !== undefined) {
    return { decision: 'deny', reason: `nauraiz-dev: ${rel} is protected (${hit})` };
  }

  if (isBookkeeping(rel, config, cwd)) return ALLOW; // the handoff and the plan itself are not scope

  const allowed = Array.isArray(plan?.allowed) ? plan.allowed.filter((p) => typeof p === 'string' && p) : [];
  if (config.scopeAsk !== false && allowed.length && !matchesAny(rel, allowed)) {
    return {
      decision: 'ask',
      reason: `nauraiz-dev: ${rel} is outside the plan's Allowed list (${plan.path}). Edit the plan first or confirm.`,
    };
  }
  return ALLOW;
}
