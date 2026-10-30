import { readFileSync } from 'node:fs';
import { toRelative } from './paths.mjs';

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

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
 */
export function gatePrefixes(gate) {
  return Object.values(gate ?? {})
    .filter((v) => typeof v === 'string')
    .map((v) => v.split('${')[0].trim())
    .filter(Boolean);
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
