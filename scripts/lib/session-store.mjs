import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';

/**
 * Per-session JSON state at <dataDir>/sessions/<sessionId>.json.
 * get() returns {} for a missing or garbled file; set(patch) shallow-merges and writes.
 */
export function sessionStore(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  const file = () => path.join(dataDir(), 'sessions', `${safe}.json`);
  const get = () => {
    try {
      const parsed = JSON.parse(readFileSync(file(), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const set = (patch) => {
    const target = file();
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ ...get(), ...patch }));
  };
  return { get, set };
}
