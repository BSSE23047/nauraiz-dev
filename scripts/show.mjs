// Print one of the plugin's own text files (a template or a skill reference) to stdout.
// Skills use this instead of reading plugin files directly: a project's own scope hook
// may deny reads outside the repo, and the plugin cache is outside every repo.
// Usage: node show.mjs <path relative to the plugin root>, e.g. templates/CLAUDE.md
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/main.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_DIRS = ['templates', 'skills'];

export function resolveShown(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const full = path.resolve(root, rel);
  const inside = path.relative(root, full);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  const top = inside.split(path.sep)[0];
  if (!ALLOWED_DIRS.includes(top)) return null;
  try {
    const real = realpathSync(full);
    const realInside = path.relative(realpathSync(root), real);
    if (realInside.startsWith('..') || path.isAbsolute(realInside)) return null;
    return real;
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) {
  const file = resolveShown(process.argv[2]);
  if (!file) {
    process.stderr.write(`nauraiz-dev: no such plugin file: ${process.argv[2] ?? ''} (templates/… or skills/… only)\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(readFileSync(file, 'utf8'));
  }
}
