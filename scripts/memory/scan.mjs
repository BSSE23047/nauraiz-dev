// Scan memory folders (project knowledge, rules, Claude Code auto-memory) for what needs a human look:
// relative dates, stale entries, references to files that are gone, broken [[links]], oversized MEMORY.md.
// Usage: node scan.mjs <dir>... [--today YYYY-MM-DD] [--stale-days N]   (prints JSON)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../lib/main.mjs';

const INDEX_NAME = 'MEMORY.md';
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25000;
const SKIP_DIRS = new Set(['node_modules', '.git']);
const DAY_MS = 86400000;

const RELATIVE_DATE = /\b(today|yesterday|tomorrow|last week|next week|this week)\b/gi;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const REF_SHAPE = /^[\w./-]+\.[A-Za-z]\w*$/; // a path with a file extension; `v1.2` and `0.2.0` are not paths
const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;

const lineCount = (text) => (text === '' ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length);

/** The text with fenced code blocks (``` or ~~~) blanked out, so prose checks ignore examples. */
function withoutFences(text) {
  const out = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      out.push('');
    } else if (m) {
      fence = m[1];
      out.push('');
    } else out.push(line);
  }
  return out.join('\n');
}

/** Valid calendar dates written YYYY-MM-DD, as strings. */
function datesIn(text) {
  const found = [];
  for (const m of text.matchAll(ISO_DATE)) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (new Date(t).toISOString().slice(0, 10) === m[0]) found.push(m[0]);
  }
  return found;
}

function cutoff(today, staleDays) {
  const t = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`today must be YYYY-MM-DD, got "${today}"`);
  return new Date(t - staleDays * DAY_MS).toISOString().slice(0, 10);
}

/** First directory at or above `start` that holds a `.git`; `start` itself when there is none. */
function repoRoot(start) {
  for (let d = start; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return start;
  }
}

function refCandidates(prose) {
  const found = new Set();
  const add = (raw) => {
    const ref = raw.trim().split('#')[0];
    if (!ref || ref.includes('://') || /^(mailto:|www\.)/i.test(ref) || ref.startsWith('/')) return;
    if (REF_SHAPE.test(ref)) found.add(ref);
  };
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) add(m[1]);
  for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) add(m[1]);
  return [...found];
}

function scanFile(file, { today, staleDays }) {
  const text = readFileSync(file, 'utf8');
  const prose = withoutFences(text);
  const dir = path.dirname(file);
  const root = repoRoot(dir);

  const dates = datesIn(text).sort();
  const newest = dates.length ? dates[dates.length - 1] : null;

  return {
    path: file,
    lines: lineCount(text),
    bytes: Buffer.byteLength(text),
    relativeDates: [...prose.matchAll(RELATIVE_DATE)].map((m) => m[0]),
    staleSince: newest && newest < cutoff(today, staleDays) ? newest : null,
    // A path counts as present from the repo root (how the notes name code) or from the note itself (how links work).
    missingRefs: refCandidates(prose).filter((ref) => !existsSync(path.resolve(root, ref)) && !existsSync(path.resolve(dir, ref))),
    brokenLinks: [...new Set([...prose.matchAll(WIKI_LINK)].map((m) => m[1].split('|')[0].split('#')[0].trim()))]
      .filter((name) => name && !existsSync(path.join(dir, `${name}.md`))),
  };
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...markdownFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Scan every `.md` file under `dirs` (a dir that does not exist is skipped). `today` is YYYY-MM-DD.
 * `index` describes the first MEMORY.md found directly in a scanned dir, else null.
 */
export function scanMemory({ dirs, today, staleDays = 90 }) {
  const opts = { today, staleDays };
  cutoff(today, staleDays); // reject a bad `today` even when there is nothing to scan
  const files = [];
  let index = null;
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const file of markdownFiles(dir)) files.push(scanFile(file, opts));
    const indexPath = path.join(dir, INDEX_NAME);
    if (!index && existsSync(indexPath)) {
      const f = files.find((x) => x.path === indexPath);
      index = { path: indexPath, lines: f.lines, overLimit: f.lines > MAX_INDEX_LINES || f.bytes > MAX_INDEX_BYTES };
    }
  }
  return { files, index };
}

function parseArgs(argv) {
  const dirs = [];
  let today = new Date().toISOString().slice(0, 10);
  let staleDays = 90;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--today') today = argv[++i];
    else if (argv[i] === '--stale-days') staleDays = Number(argv[++i]);
    else dirs.push(argv[i]);
  }
  return { dirs, today, staleDays };
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.dirs.length || !Number.isFinite(args.staleDays)) {
      process.stderr.write('usage: node scan.mjs <dir>... [--today YYYY-MM-DD] [--stale-days N]\n');
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(scanMemory(args), null, 2)}\n`);
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}
