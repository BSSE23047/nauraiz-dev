import { elapsedMinutes, gatePrefixes, lastEditTs, lastGateTs, tokenTotals } from './transcript.mjs';
import { isBookkeeping } from './bookkeeping.mjs';

/**
 * Pure Stop-hook decision.
 * `warned` lists the problems already warned about this session (anything not an array counts as none).
 * Returns { costLine, warning, block, problems, warnedAfter }: `warning` names only problems not yet
 * warned about (never in advisory mode), and `warnedAfter` is `warned` plus those; `block` is true in
 * strict mode whenever a problem exists. With `cwd`, edits to bookkeeping files (isBookkeeping) are
 * not counted as work.
 */
/** 82 → "82", 15363 → "15.4k", 3157462 → "3.16M". */
export function compact(n) {
  if (n < 1000) return String(n);
  if (n < 999950) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
}

export function decideStop({ config, found, entries, sessionMdMtime, warned, cwd, subagentEntries = [] }) {
  const t = tokenTotals(entries);
  const sub = tokenTotals(subagentEntries);
  const mins = elapsedMinutes(entries);
  const costLine = `nauraiz-dev · tokens this session: main out ${compact(t.output)}, `
    + `cache read ${compact(t.cacheRead)}, cache write ${compact(t.cacheWrite)}, input ${compact(t.input)}`
    + (sub.output > 0 || sub.cacheRead > 0 ? ` · subagents out ${compact(sub.output)}, cache read ${compact(sub.cacheRead)}` : '')
    + (mins !== null ? ` · ${mins} min` : '');

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
