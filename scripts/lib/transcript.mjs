import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { toRelative } from './paths.mjs';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SUBAGENT_MAX_BYTES = 64 * 1024 * 1024;

function parseTs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toEntry(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const message = rec.message && typeof rec.message === 'object' ? rec.message : null;
  const roleSrc = message?.role ?? rec.type;
  const role = roleSrc === 'assistant' || roleSrc === 'user' ? roleSrc : 'other';
  const toolUses = Array.isArray(message?.content)
    ? message.content
        .filter((c) => c && c.type === 'tool_use' && typeof c.name === 'string')
        .map((c) => ({ name: c.name, input: c.input ?? {} }))
    : [];
  const u = message?.usage;
  const usage = u && typeof u === 'object'
    ? {
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        cacheWrite: Number(u.cache_creation_input_tokens) || 0,
      }
    : null;
  // msgId lets tokenTotals count a multi-line API message once.
  return { ts: parseTs(rec.timestamp), role, toolUses, usage, msgId: typeof message?.id === 'string' ? message.id : null };
}

/**
 * Parse a JSONL session transcript. One entry per parsable line; bad lines are skipped;
 * a missing or unreadable file gives []. Whole-file read: fine for v1 under the hook timeouts.
 */
export function readTranscript(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return parseTranscript(text);
}

/** Entries of a transcript's text (see readTranscript). */
function parseTranscript(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const entry = toEntry(rec);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Entries of every subagent transcript of a session: for `<dir>/<id>.jsonl` the files are
 * `<dir>/<id>/subagents/agent-*.jsonl` (their `.meta.json` neighbours are ignored). No dir gives [].
 */
export function readSubagentEntries(transcriptPath) {
  return subagentFiles(transcriptPath).flatMap((f) => readTranscript(f));
}

/** Absolute paths of a session's subagent transcripts (sorted); [] when there are none. */
function subagentFiles(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return [];
  const dir = path.join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents');
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.jsonl')).sort().map((n) => path.join(dir, n));
}

/**
 * Summed token totals of a session's subagent transcripts without re-reading finished ones.
 * `cache` maps a file path to `{ size, mtimeMs, totals }` from an earlier call; an entry whose size and
 * mtime still match is trusted. Files not cached are read until `maxBytes` would be passed; the rest are
 * skipped and `partial` is true. Returns `{ totals, cache, partial }`; the returned cache holds only the
 * files present now (store it for the next call).
 */
export function subagentUsage(transcriptPath, { cache = {}, maxBytes = SUBAGENT_MAX_BYTES } = {}) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const next = {};
  let budget = maxBytes;
  let partial = false;
  const prior = cache && typeof cache === 'object' ? cache : {};
  for (const file of subagentFiles(transcriptPath)) {
    let st;
    try { st = statSync(file); } catch { continue; }
    const hit = prior[file];
    let fileTotals;
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.totals && typeof hit.totals === 'object') {
      fileTotals = hit.totals;
    } else if (st.size > budget) {
      partial = true;
      continue;
    } else {
      budget -= st.size;
      let text;
      // a read error (EBUSY, EACCES) is not an empty file: leave it uncached so the next stop reads it again
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      fileTotals = tokenTotals(parseTranscript(text));
    }
    next[file] = { size: st.size, mtimeMs: st.mtimeMs, totals: fileTotals };
    for (const k of Object.keys(totals)) totals[k] += Number(fileTotals[k]) || 0;
  }
  return { totals, cache: next, partial };
}

/** Whole minutes from the first to the last timestamp; null with fewer than two timestamps. */
export function elapsedMinutes(entries) {
  // a loop, not Math.max(...times): spreading a long session's timestamps overflows the call stack
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const e of entries) {
    if (e.ts === null) continue;
    count++;
    if (e.ts < min) min = e.ts;
    if (e.ts > max) max = e.ts;
  }
  if (count < 2) return null;
  return Math.round((max - min) / 60000);
}

function maxTs(entries, pred) {
  let best = null;
  for (const e of entries) {
    if (e.ts === null || !pred(e)) continue;
    if (best === null || e.ts > best) best = e.ts;
  }
  return best;
}

/**
 * Latest timestamp of a Write/Edit/MultiEdit/NotebookEdit tool use, or null.
 * With `{ cwd, exclude }`, an edit whose `file_path`/`notebook_path` (made relative to `cwd`)
 * satisfies `exclude(rel)` is ignored; an edit without a path always counts.
 */
export function lastEditTs(entries, { cwd, exclude } = {}) {
  const skip = (t) => {
    if (typeof exclude !== 'function' || typeof cwd !== 'string' || !cwd) return false;
    const file = t.input?.file_path ?? t.input?.notebook_path;
    return typeof file === 'string' && file !== '' && exclude(toRelative(cwd, file));
  };
  return maxTs(entries, (e) => e.toolUses.some((t) => EDIT_TOOLS.has(t.name) && !skip(t)));
}

/**
 * The usable gate prefixes: each string gate value cut at its first `${`, trimmed; empty ones dropped.
 * A gate with no usable prefix cannot be detected in a transcript, so it counts as no gate.
 * When there is a gate, a call of the gate runner counts too (it runs the same commands).
 */
export function gatePrefixes(gate) {
  const prefixes = Object.values(gate ?? {})
    .filter((v) => typeof v === 'string')
    .map((v) => v.split('${')[0].trim())
    .filter(Boolean);
  return prefixes.length ? [...prefixes, 'scripts/gate/run.mjs'] : prefixes;
}

/**
 * Latest timestamp of a shell tool use (any tool whose `input.command` is a string: Bash, PowerShell, ...)
 * whose command includes a gate prefix.
 */
export function lastGateTs(entries, gate) {
  const prefixes = gatePrefixes(gate);
  if (prefixes.length === 0) return null;
  return maxTs(entries, (e) => e.toolUses.some((t) => {
    const cmd = t.input?.command;
    return typeof cmd === 'string' && prefixes.some((p) => cmd.includes(p));
  }));
}

/** Sum usage, counting each API message.id once (lines without an id count individually). */
export function tokenTotals(entries) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const seen = new Set();
  for (const e of entries) {
    if (!e.usage) continue;
    if (e.msgId) {
      if (seen.has(e.msgId)) continue;
      seen.add(e.msgId);
    }
    totals.input += e.usage.input;
    totals.output += e.usage.output;
    totals.cacheRead += e.usage.cacheRead;
    totals.cacheWrite += e.usage.cacheWrite;
  }
  totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return totals;
}
