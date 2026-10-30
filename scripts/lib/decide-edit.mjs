import { toRelative, matchesAny, normalize } from './paths.mjs';
import { isBookkeeping, isUnderPlanDir } from './bookkeeping.mjs';

const ALLOW = Object.freeze({ decision: 'allow', reason: '' });

const APPROVAL_LINE = /^[ \t]*(?:-[ \t]+)?([\w-]+)[ \t]*:[ \t]*(.*)$/gm;

/**
 * Every recorded owner approval in `text`: `approval:` / `*_approval:` lines (key case-insensitive, an
 * optional leading `- ` list marker) whose value, with a surrounding or an unbalanced leading quote
 * stripped, is non-empty and does not start with `pending`.
 */
export function findRecordedApprovals(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const [, rawKey, raw] of text.matchAll(APPROVAL_LINE)) {
    const key = rawKey.toLowerCase();
    if (key !== 'approval' && !key.endsWith('_approval')) continue;
    const value = raw.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/^["']/, '').trim();
    if (value && !/^pending/i.test(value)) out.push(value);
  }
  return out;
}

/** The first recorded owner approval in `text`, or null. */
export function findRecordedApproval(text) {
  return findRecordedApprovals(text)[0] ?? null;
}

/** A plan file: under `config.plan.dir`, or a .md under a `tasks/` or `plans/` directory. */
export function isPlanFile(rel, config, cwd) {
  if (isUnderPlanDir(rel, config, cwd)) return true;
  const p = normalize(rel);
  return p.toLowerCase().endsWith('.md') && /(^|\/)(tasks|plans)\//i.test(p);
}

/**
 * Decide whether an edit to `filePath` may proceed. Pure: `plan` is already resolved by the caller.
 * No config, or enforcement advisory (context only, spec 6.6) -> allow. Protected path -> deny.
 * A plan that records an owner approval (`*_approval:` not "pending ...") -> ask, before the bookkeeping
 * allow (plans live in the plan dir). `newText` is the file text after the edit (absent -> no approval
 * check); with `oldText` (the text before) only an approval value the old text lacks counts as new.
 * Outside the plan's Allowed list -> ask (not when `config.scopeAsk === false`, which init sets when the
 * project already has its own PreToolUse edit hook), except for bookkeeping files (the plan dir,
 * .claude/state/**, .work/handoff.md), which are never asked about. Anything else -> allow.
 */
export function decideEdit({ cwd, filePath, config, found, plan, newText, oldText }) {
  if (!found || !config || config.enforcement === 'advisory') return ALLOW;
  const rel = toRelative(cwd, filePath);

  const protectedPaths = (Array.isArray(config.protectedPaths) ? config.protectedPaths : [])
    .filter((p) => typeof p === 'string' && p);
  const hit = protectedPaths.find((pattern) => matchesAny(rel, [pattern]));
  if (hit !== undefined) {
    return { decision: 'deny', reason: `nauraiz-dev: ${rel} is protected (${hit})` };
  }

  if (typeof newText === 'string' && isPlanFile(rel, config, cwd)) {
    const known = new Set(findRecordedApprovals(oldText));
    const approval = findRecordedApprovals(newText).find((v) => !known.has(v)) ?? null;
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
