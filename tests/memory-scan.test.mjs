import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanMemory } from '../scripts/memory/scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'memory', 'scan.mjs');
const TODAY = '2026-10-31';

/** Copy tests/fixtures/memory into a temp "repo" (it gets a .git dir and src/exists.js) and return its root. */
function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nd-mem-'));
  cpSync(path.join(here, 'fixtures', 'memory'), root, { recursive: true });
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'exists.js'), '');
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs', 'setup.md'), '');
  return root;
}

const byName = (result, name) => result.files.find((f) => path.basename(f.path) === name);

function withRepo(fn) {
  const root = repo();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('relativeDates: finds relative-date words outside fenced code, keeps what was matched', () => withRepo((root) => {
  const r = scanMemory({ dirs: [path.join(root, 'knowledge')], today: TODAY });
  const f = byName(r, 'dates.md');
  assert.deepEqual(f.relativeDates, ['yesterday', 'next week', 'Today', 'THIS WEEK']);
  assert.deepEqual(byName(r, 'fresh.md').relativeDates, []);
}));

test('staleSince: newest date in the file when older than today minus staleDays, else null', () => withRepo((root) => {
  const dirs = [path.join(root, 'knowledge')];
  const stale = (opts, name) => byName(scanMemory({ dirs, ...opts }), name).staleSince;
  assert.equal(stale({ today: TODAY }, 'stale.md'), '2026-03-02', 'the newest of two dates');
  assert.equal(stale({ today: TODAY }, 'fresh.md'), null);
  assert.equal(stale({ today: TODAY }, 'dates.md'), null);
  assert.equal(stale({ today: TODAY }, 'links.md'), null, 'no date, nothing to be stale');
  // 2026-12-30 minus 90 days is 2026-10-01: a date on the cutoff day is not older than it, the day before is.
  assert.equal(stale({ today: '2026-12-30' }, 'fresh.md'), null);
  assert.equal(stale({ today: '2026-12-31' }, 'fresh.md'), '2026-10-01');
  assert.equal(stale({ today: '2026-12-30', staleDays: 30 }, 'fresh.md'), '2026-10-01');
  assert.equal(stale({ today: '2026-12-30', staleDays: 100 }, 'fresh.md'), null);
}));

test('missingRefs: backticked and linked relative paths that do not exist; URLs, fences and non-paths skipped', () => withRepo((root) => {
  const f = byName(scanMemory({ dirs: [path.join(root, 'knowledge')], today: TODAY }), 'refs.md');
  assert.deepEqual(f.missingRefs.sort(), ['docs/missing.md', 'lost.md', 'src/gone.js']);
}));

test('missingRefs: a link relative to the file itself counts as existing', () => withRepo((root) => {
  const f = byName(scanMemory({ dirs: [path.join(root, 'knowledge')], today: TODAY }), 'refs.md');
  assert.ok(!f.missingRefs.includes('fresh.md'));
}));

test('missingRefs: without a .git above the file the root is the file directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-mem-nogit-'));
  try {
    writeFileSync(path.join(dir, 'a.md'), 'See `b.md` and `c.md`.\n');
    writeFileSync(path.join(dir, 'b.md'), '');
    const f = scanMemory({ dirs: [dir], today: TODAY }).files.find((x) => x.path.endsWith('a.md'));
    assert.deepEqual(f.missingRefs, ['c.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('brokenLinks: [[name]] with no name.md beside the file, alias and anchor stripped', () => withRepo((root) => {
  const r = scanMemory({ dirs: [path.join(root, 'knowledge')], today: TODAY });
  assert.deepEqual(byName(r, 'links.md').brokenLinks, ['ghost']);
  assert.deepEqual(byName(r, 'fresh.md').brokenLinks, []);
}));

test('index: MEMORY.md of a scanned dir, with lines, and not over the limit', () => withRepo((root) => {
  const r = scanMemory({ dirs: [path.join(root, 'auto')], today: TODAY });
  assert.equal(r.index.path, path.join(root, 'auto', 'MEMORY.md'));
  assert.equal(r.index.lines, 2);
  assert.equal(r.index.overLimit, false);
  assert.deepEqual(byName(r, 'MEMORY.md').missingRefs, ['gone.md']);
  assert.equal(scanMemory({ dirs: [path.join(root, 'knowledge')], today: TODAY }).index, null);
}));

test('index: overLimit above 200 lines or above 25,000 bytes, not at the limits', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-mem-index-'));
  try {
    const check = (text) => {
      writeFileSync(path.join(dir, 'MEMORY.md'), text);
      return scanMemory({ dirs: [dir], today: TODAY }).index;
    };
    const lines = (n) => Array.from({ length: n }, (_, i) => `- entry ${i}`).join('\n') + '\n';
    assert.deepEqual([check(lines(200)).lines, check(lines(200)).overLimit], [200, false]);
    assert.deepEqual([check(lines(201)).lines, check(lines(201)).overLimit], [201, true]);
    const exact = 'x'.repeat(25000);
    assert.equal(check(exact).overLimit, false);
    assert.equal(check(exact + 'y').overLimit, true);
    assert.equal(check('é'.repeat(12501)).overLimit, true, 'bytes, not characters');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('files: path, lines and bytes; a missing dir is skipped; only markdown is read', () => withRepo((root) => {
  writeFileSync(path.join(root, 'knowledge', 'notes.txt'), 'yesterday');
  const r = scanMemory({ dirs: [path.join(root, 'knowledge'), path.join(root, 'no-such-dir')], today: TODAY });
  const f = byName(r, 'stale.md');
  assert.equal(f.path, path.join(root, 'knowledge', 'stale.md'));
  assert.equal(f.lines, 4);
  assert.equal(f.bytes, statSync(f.path).size);
  assert.equal(r.files.filter((x) => x.path.endsWith('.txt')).length, 0);
}));

test('CLI: prints the scan as JSON and takes --today', () => withRepo((root) => {
  const out = spawnSync(process.execPath, [script, path.join(root, 'knowledge'), path.join(root, 'auto'), '--today', TODAY], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout);
  assert.equal(r.files.find((f) => f.path.endsWith('stale.md')).staleSince, '2026-03-02');
  assert.equal(r.index.lines, 2);
}));

test('CLI: no directory is a usage error', () => {
  const out = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /usage/i);
});

test('index: a MEMORY.md that is not a readable file leaves index null instead of throwing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-mem-odd-'));
  try {
    mkdirSync(path.join(dir, 'MEMORY.md'));
    assert.equal(scanMemory({ dirs: [dir], today: TODAY }).index, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
