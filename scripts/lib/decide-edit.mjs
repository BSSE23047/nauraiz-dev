import { toRelative, matchesAny, normalize } from './paths.mjs';
import { isBookkeeping } from './bookkeeping.mjs';

const ALLOW = Object.freeze({ decision: 'allow', reason: '' });

const APPROVAL_LINE = /^[ \t]*([\w-]+)[ \t]*:[ \t]*(.*)$/gm;

/**
 * The first recorded owner approval in `text`: a `approval:` or `*_approval:` line whose value (quotes
 * stripped) is non-empty and does not start with `pending`. Null when there is none.
 */
export function findRecordedApproval(text) {
  if (typeof text !== 'string') return null;
  for (const [, key, raw] of text.matchAll(APPROVAL_LINE)) {
    if (key !== 'approval' && !key.endsWith('_approval')) continue;
    const value = raw.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (value && !/^pending/i.test(value)) return value;
  }
  return null;
}

/** A plan file: under `config.plan.dir`, or a .md under a `tasks/` or `plans/` directory. */
function isPlanFile(rel, config, cwd) {
  const dir = config?.plan?.dir;
  if (typeof dir === 'string' && dir.trim()) {
    const dirRel = typeof cwd === 'string' && cwd ? toRelative(cwd, dir) : normalize(dir);
    const outside = dirRel === '' || dirRel === '..' || dirRel.startsWith('../') || dirRel.startsWith('/') || /^[A-Za-z]:/.test(dirRel);
    if (!outside && matchesAny(rel, [`/${dirRel}/`])) return true;
  }
  const p = normalize(rel);
  return p.toLowerCase().endsWith('.md') && /(^|\/)(tasks|plans)\//i.test(p);
}

/**
 * Decide whether an edit to `filePath` may proceed. Pure: `plan` is already resolved by the caller.
 * No config, or enforcement advisory (context only, spec 6.6) -> allow. Protected path -> deny.
 * A plan that records an owner approval (`*_approval:` not "pending ...") -> ask, before the bookkeeping
 * allow (plans live in the plan dir); `newText` is what the tool writes (absent -> no approval check).
 * Outside the plan's Allowed list -> ask (not when `config.scopeAsk === false`, which init sets when the
 * project already has its own PreToolUse edit hook), except for bookkeeping files (the plan dir,
 * .claude/state/**, .work/handoff.md), which are never asked about. Anything else -> allow.
 */
export function decideEdit({ cwd, filePath, config, found, plan, newText }) {
  if (!found || !config || config.enforcement === 'advisory') return ALLOW;
  const rel = toRelative(cwd, filePath);

  const protectedPaths = (Array.isArray(config.protectedPaths) ? config.protectedPaths : [])
    .filter((p) => typeof p === 'string' && p);
  const hit = protectedPaths.find((pattern) => matchesAny(rel, [pattern]));
  if (hit !== undefined) {
    return { decision: 'deny', reason: `nauraiz-dev: ${rel} is protected (${hit})` };
  }

  if (typeof newText === 'string' && isPlanFile(rel, config, cwd)) {
    const approval = findRecordedApproval(newText);
    if (approval !== null) {
      return {
        decision: 'ask',
        reason: `nauraiz-dev: this plan records an approval: "${approval}". Did the owner give it in this session? If not, write "pending owner confirmation".`,
      };
    }
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
