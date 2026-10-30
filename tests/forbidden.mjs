// Words that must never appear in the published plugin (client and private names).
// The list itself is private: one term per line in a git-ignored `.forbidden-terms`
// at the repo root. Without that file the guard tests only check for e-mail addresses.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function forbiddenPattern() {
  const file = path.join(root, '.forbidden-terms');
  if (!existsSync(file)) return null;
  const terms = readFileSync(file, 'utf8').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return null;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
}
