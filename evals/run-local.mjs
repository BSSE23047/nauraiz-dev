#!/usr/bin/env node
// Run the eval suite against a copy of the plugin whose manifest has no `dependencies`.
// `claude plugin eval` isolates user config, so superpowers is never installed in the run
// and a plugin that declares it fails to load ("dependency-unsatisfied"). The shipped
// plugin.json is untouched. Extra arguments are passed to `claude plugin eval`.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = ['.git', 'node_modules', '.superpowers', '.work'].map((n) => join(root, n));
const copy = join(mkdtempSync(join(tmpdir(), 'nauraiz-dev-eval-')), 'plugin');

cpSync(root, copy, {
  recursive: true,
  filter: (src) => !skip.includes(src) && !src.startsWith(join(root, 'evals', 'results') + sep),
});
const manifest = join(copy, '.claude-plugin', 'plugin.json');
const json = JSON.parse(readFileSync(manifest, 'utf8'));
delete json.dependencies;
writeFileSync(manifest, JSON.stringify(json, null, 2));

const args = ['plugin', 'eval', '.', '--trust-plugin', '--no-publish', ...process.argv.slice(2)];
const run = spawnSync('claude', args, { cwd: copy, stdio: 'inherit', shell: process.platform === 'win32' });

const results = join(copy, 'evals', 'results');
if (existsSync(results)) {
  mkdirSync(join(root, 'evals', 'results'), { recursive: true });
  cpSync(results, join(root, 'evals', 'results'), { recursive: true });
}
rmSync(dirname(copy), { recursive: true, force: true });
process.exit(run.status ?? 1);
