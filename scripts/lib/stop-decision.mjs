import { gatePrefixes, lastEditTs, lastGateTs, tokenTotals } from './transcript.mjs';
import { isBookkeeping } from './bookkeeping.mjs';

/**
 * Pure Stop-hook decision.
 * `warned` lists the problems already warned about this session (anything not an array counts as none).
 * Returns { costLine, warning, block, problems, warnedAfter }: `warning` names only problems not yet
 * warned about (never in advisory mode), and `warnedAfter` is `warned` plus those; `block` is true in
 * strict mode whenever a problem exists. With `cwd`, edits to bookkeeping files (isBookkeeping) are
 * not counted as work.
 */
export function decideStop({ config, found, entries, sessionMdMtime, warned, cwd }) {
  const totals = tokenTotals(entries);
  const costLine = `nauraiz-dev · tokens in/out/cache: ${totals.input}/${totals.output}/${totals.cacheRead}`;

  const editTs = lastEditTs(entries, { cwd, exclude: (rel) => isBookkeeping(rel, config, cwd) });
  const edits = editTs !== null;
  const problems = [];

  const hasGate = gatePrefixes(config.gate).length > 0; // same list lastGateTs searches for
  if (edits && hasGate) {
    const gateTs = lastGateTs(entries, config.gate);
    if (!(gateTs !== null && gateTs >= editTs)) problems.push('gate not run after last edit');
  }
  if (found && config.state === 'scaffold' && edits && (sessionMdMtime === null || sessionMdMtime < editTs)) {
    problems.push('session.md older than last edit');
  }

  const already = Array.isArray(warned) ? warned.filter((p) => typeof p === 'string') : [];
  const fresh = config.enforcement === 'advisory' ? [] : problems.filter((p) => !already.includes(p));
  const warning = fresh.length > 0 ? fresh.join('; ') : null;
  const block = config.enforcement === 'strict' && problems.length > 0;
  return { costLine, warning, block, problems, warnedAfter: [...already, ...fresh] };
}
