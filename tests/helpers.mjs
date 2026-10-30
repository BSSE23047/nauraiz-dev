import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const reposDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'repos');

/** Absolute path of tests/fixtures/repos/<name>. */
export const fx = (name) => path.join(reposDir, name);

/** UTF-8 text of tests/fixtures/repos/<rel>. */
export const read = (rel) => readFileSync(path.join(reposDir, rel), 'utf8');

const hooksDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hooks');

/**
 * Run scripts/hooks/<name>.mjs with `payload` as JSON on stdin. Resolves
 * { stdout, stderr, code } and never rejects on a non-zero exit (so tests can assert exit 2).
 */
export function runHook(name, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(hooksDir, `${name}.mjs`)],
      { cwd: payload?.cwd, env: { ...process.env, ...env }, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') return reject(err);
        resolve({ stdout, stderr, code: err ? err.code : 0 });
      },
    );
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}
