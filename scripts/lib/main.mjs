import { fileURLToPath } from 'node:url';
import { realPath } from './paths.mjs';

/**
 * True when the running script (`process.argv[1]`) is the module whose `import.meta.url` is passed.
 * Both sides go through realpath, because Node resolves `import.meta.url` through symlinks and
 * junctions while `process.argv[1]` keeps the path as typed (native realpath: 8.3 short names are expanded too). Case-insensitive on win32; any fs error gives false.
 */
export function isMain(importMetaUrl) {
  try {
    if (!process.argv[1]) return false;
    const a = realPath(process.argv[1]);
    const b = realPath(fileURLToPath(importMetaUrl));
    if (a === null || b === null) return false;
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}
