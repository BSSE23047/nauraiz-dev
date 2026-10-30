import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, dataDir, DEFAULTS, MAX_CONTEXT_CHARS } from '../scripts/lib/config.mjs';
import { fx } from './helpers.mjs';

const stdinUrl = new URL('../scripts/lib/stdin.mjs', import.meta.url).href;

test('missing config is advisory and not found', () => {
  const { config, found, error } = loadConfig(fx('empty'));
  assert.equal(found, false); assert.equal(error, null); assert.equal(config.enforcement, 'advisory');
});
test('broken config is advisory with error', () => {
  const r = loadConfig(fx('broken')); assert.equal(r.found, false); assert.match(r.error, /JSON/);
});
test('local overrides project and env is always protected', () => {
  const { config } = loadConfig(fx('configured'));
  assert.equal(config.mockupRoot, 'C:/mockups');           // from .local.json
  assert.equal(config.enforcement, 'guided');              // from project json
  assert.ok(config.protectedPaths.includes('.env*'));
  assert.equal(config.protectedPaths.filter(p => p === '.env*').length, 1);
});
test('scaffold defaults plan dir', () => {
  assert.equal(loadConfig(fx('scaffold')).config.plan.dir, 'docs/superpowers/plans');
});
test('defaults survive a merge and are not mutated', () => {
  const { config } = loadConfig(fx('configured'));
  assert.deepEqual(config.models, DEFAULTS.models);
  assert.equal(config.branch.base, 'main');
  assert.equal(DEFAULTS.protectedPaths.length, 0);
  assert.equal(loadConfig(fx('empty')).config.plan.dir, '.work/tasks');
});
test('dataDir honours CLAUDE_PLUGIN_DATA and creates it', () => {
  const target = path.join(os.tmpdir(), `nauraiz-dev-test-${process.pid}`);
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = target;
  try {
    assert.equal(dataDir(), target);
    assert.ok(existsSync(target));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev;
    rmSync(target, { recursive: true, force: true });
  }
  assert.equal(MAX_CONTEXT_CHARS, 6000);
});
test('readStdinJson parses JSON and returns null on empty or invalid input', () => {
  const run = (input) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { readStdinJson } from ${JSON.stringify(stdinUrl)}; console.log(JSON.stringify(await readStdinJson()));`],
    { input, encoding: 'utf8' }).stdout);
  assert.deepEqual(run('{"a":1}'), { a: 1 });
  assert.equal(run(''), null);
  assert.equal(run('{ nope'), null);
});
test('scaffold with plan: null does not throw and falls back to defaults', () => {
  const r = loadConfig(fx('scaffold-null-plan'));
  assert.equal(r.found, true);
  assert.equal(r.config.plan.dir, 'docs/superpowers/plans');
  assert.equal(r.config.plan.template, null);
  assert.match(r.error, /plan must be an object/);
});
test('a non-object container (string plan) does not throw', () => {
  const r = loadConfig(fx('scaffold-string-plan'));
  assert.equal(r.found, true);
  assert.equal(r.config.plan.dir, 'docs/superpowers/plans');
  assert.match(r.error, /plan must be an object/);
});
test('bad local file keeps project values, found stays true, error set', () => {
  const r = loadConfig(fx('bad-local'));
  assert.equal(r.found, true);
  assert.equal(r.config.enforcement, 'strict');
  assert.ok(r.config.protectedPaths.includes('secrets/**'));
  assert.ok(r.config.protectedPaths.includes('.env*'));
  assert.match(r.error, /nauraiz-dev\.local\.json/);
});
test('valid-JSON non-object project file is advisory, not found, with error', () => {
  const r = loadConfig(fx('array-project'));
  assert.equal(r.found, false);
  assert.equal(r.config.enforcement, 'advisory');
  assert.ok(r.error);
});
test('explicit plan.dir beats the scaffold default', () => {
  const r = loadConfig(fx('explicit-plan-dir'));
  assert.equal(r.config.plan.dir, 'custom/plans');
  assert.equal(r.error, null);
});
test('found config without enforcement is guided; explicit advisory stays; not found stays advisory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-enf-'));
  try {
    mkdirSync(path.join(dir, '.claude'));
    const write = (name, obj) => writeFileSync(path.join(dir, '.claude', name), JSON.stringify(obj));
    write('nauraiz-dev.json', { state: 'none' });
    assert.equal(loadConfig(dir).config.enforcement, 'guided');
    write('nauraiz-dev.local.json', { enforcement: 'advisory' });
    assert.equal(loadConfig(dir).config.enforcement, 'advisory');
    write('nauraiz-dev.json', { enforcement: 'strict' });
    rmSync(path.join(dir, '.claude', 'nauraiz-dev.local.json'));
    assert.equal(loadConfig(dir).config.enforcement, 'strict');
    write('nauraiz-dev.json', { enforcement: 'advisory' });
    assert.equal(loadConfig(dir).config.enforcement, 'advisory');
    assert.equal(loadConfig(fx('empty')).config.enforcement, 'advisory');
    assert.equal(DEFAULTS.enforcement, 'advisory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('scaffold fixture (no enforcement key) loads as guided', () => {
  assert.equal(loadConfig(fx('scaffold')).config.enforcement, 'guided');
});

// I4: present tells "no file" from "file exists but unreadable".
test('present is true whenever the project file exists, readable or not', () => {
  assert.equal(loadConfig(fx('empty')).present, false);
  assert.equal(loadConfig(fx('broken')).present, true);
  assert.equal(loadConfig(fx('array-project')).present, true);
  assert.equal(loadConfig(fx('configured')).present, true);
  assert.equal(loadConfig(fx('broken')).found, false);
});

test('a wrong-shaped value in .local.json is skipped with an error; the project value is kept', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-layer-'));
  try {
    mkdirSync(path.join(dir, '.claude'));
    const write = (name, obj) => writeFileSync(path.join(dir, '.claude', name), JSON.stringify(obj));
    write('nauraiz-dev.json', { enforcement: 'strict', protectedPaths: ['secrets/**'], gate: { test: 'npm test' }, plan: { dir: 'custom/plans' } });
    write('nauraiz-dev.local.json', { protectedPaths: 'x', gate: 'x', plan: 'x', mockupRoot: 'C:/m' });
    const r = loadConfig(dir);
    assert.equal(r.found, true);
    assert.deepEqual(r.config.protectedPaths, ['secrets/**', '.env*']);
    assert.deepEqual(r.config.gate, { test: 'npm test' });
    assert.equal(r.config.plan.dir, 'custom/plans');
    assert.equal(r.config.mockupRoot, 'C:/m', 'the well-shaped local values still apply');
    assert.equal(r.config.enforcement, 'strict');
    for (const key of ['protectedPaths', 'gate', 'plan']) assert.match(r.error, new RegExp(`nauraiz-dev\\.local\\.json: ${key} must be`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a wrong-shaped value in the project file still falls back to the default', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-layer-'));
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), JSON.stringify({ protectedPaths: 'x', gate: [] }));
    const r = loadConfig(dir);
    assert.deepEqual(r.config.protectedPaths, ['.env*']);
    assert.deepEqual(r.config.gate, {});
    assert.match(r.error, /protectedPaths must be an array/);
    assert.match(r.error, /gate must be an object/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local file alone loads as found, mode local, guided', () => {
  const r = loadConfig(fx('local-only'));
  assert.equal(r.found, true);
  assert.equal(r.present, false);
  assert.equal(r.mode, 'local');
  assert.equal(r.error, null);
  assert.equal(r.config.enforcement, 'guided');
  assert.equal(r.config.gate.test, 'npm test');
  assert.ok(r.config.protectedPaths.includes('.env*'));
  assert.deepEqual(r.config.sharedPaths, ['src/shared/**']);
});

test('project config reports mode project', () => {
  assert.equal(loadConfig(fx('configured')).mode, 'project');
});

test('no config reports mode none', () => {
  const r = loadConfig(fx('empty'));
  assert.equal(r.mode, 'none');
  assert.equal(r.found, false);
});

test('wrong-shaped sharedPaths is dropped with an error', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-shared-'));
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.json'), JSON.stringify({ sharedPaths: 'x' }));
    const r = loadConfig(dir);
    assert.deepEqual(r.config.sharedPaths, []);
    assert.match(r.error, /sharedPaths must be an array/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('models.explore defaults to haiku', () => {
  assert.equal(loadConfig(fx('configured')).config.models.explore, 'haiku');
});

test('unreadable local-only file reports the error and no config', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-local-bad-'));
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'nauraiz-dev.local.json'), '{oops');
    const r = loadConfig(dir);
    assert.equal(r.found, false);
    assert.equal(r.present, false);
    assert.equal(r.mode, 'none');
    assert.match(r.error, /invalid JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
