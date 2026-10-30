import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the running script (`process.argv[1]`) is the module whose `import.meta.url` is passed.
 * Both sides go through realpath, because Node resolves `import.meta.url` through symlinks and
 * junctions while `process.argv[1]` keeps the path as typed. Case-insensitive on win32; any fs error gives false.
 */
export function isMain(importMetaUrl) {
  try {
    if (!process.argv[1]) return false;
    const a = realpathSync(process.argv[1]);
    const b = realpathSync(fileURLToPath(importMetaUrl));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}
