import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../scripts/lib/main.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(root, 'scripts');

// A link to scripts/ (junction on win32 needs no privilege). null when it cannot be created.
function linkToScripts(tmp) {
  const link = path.join(tmp, 'linked-scripts');
  try {
    symlinkSync(scriptsDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    return link;
  } catch {
    return null;
  }
}

test('isMain: false when argv[1] is another file or missing, and for a bad url', () => {
  assert.equal(isMain(pathToFileURL(path.join(scriptsDir, 'show.mjs')).href), false); // argv[1] is the test, not show.mjs
  assert.equal(isMain('file:///does/not/exist.mjs'), false);
  assert.equal(isMain('not a url'), false);
});

test('run.mjs and show.mjs still run when started through a symlinked scripts dir', (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-main-'));
  try {
    const link = linkToScripts(tmp);
    if (!link) return t.skip('cannot create a symlink or junction here');

    const proj = path.join(tmp, 'proj');
    mkdirSync(path.join(proj, '.claude'), { recursive: true });
    writeFileSync(path.join(proj, '.claude', 'nauraiz-dev.json'), JSON.stringify({ enforcement: 'guided' }));
    const gate = spawnSync(process.execPath, [path.join(link, 'gate', 'run.mjs'), '--cwd', proj], { encoding: 'utf8' });
    assert.equal(gate.status, 2, gate.stdout + gate.stderr);
    assert.match(gate.stdout + gate.stderr, /nauraiz-dev: no gate configured/);

    const show = spawnSync(process.execPath, [path.join(link, 'show.mjs'), 'templates/CLAUDE.md'], { encoding: 'utf8' });
    assert.equal(show.status, 0, show.stderr);
    assert.equal(show.stdout, readFileSync(path.join(root, 'templates', 'CLAUDE.md'), 'utf8'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
