import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveShown } from '../scripts/show.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'show.mjs');

test('prints a template and a skill reference', () => {
  const t = execFileSync('node', [script, 'templates/nauraiz-dev.json'], { encoding: 'utf8' });
  assert.match(t, /"enforcement"/);
  const r = execFileSync('node', [script, 'skills/handoff/reference.md'], { encoding: 'utf8' });
  assert.match(r, /Goal/);
});

test('refuses paths outside templates/ and skills/', () => {
  for (const bad of ['package.json', '../package.json', 'templates/../package.json', 'scripts/show.mjs', '', path.join(root, 'templates', 'CLAUDE.md')]) {
    assert.equal(resolveShown(bad), null, bad);
  }
  assert.equal(resolveShown(undefined), null);
});

test('unknown file exits 1 with a message and no stdout', () => {
  const r = spawnSync('node', [script, 'templates/nope.md'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no such plugin file/);
});
