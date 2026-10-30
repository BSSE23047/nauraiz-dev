#!/usr/bin/env node
// Stop hook: one-line token cost, warn once per problem (guided) and block (strict) when the gate/handoff is stale.
// Never throws: any failure -> exit 0, no output. stop_hook_active short-circuits to avoid loops.
import { statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { readStdinJson } from '../lib/stdin.mjs';
import { readTranscript } from '../lib/transcript.mjs';
import { decideStop } from '../lib/stop-decision.mjs';
import { sessionStore } from '../lib/session-store.mjs';

async function main() {
  const input = await readStdinJson();
  const payload = input && typeof input === 'object' ? input : {};
  if (payload.stop_hook_active === true) return;

  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const sessionId = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : 'unknown';
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';

  const { config, found } = loadConfig(cwd);
  const entries = transcript ? readTranscript(transcript) : [];

  let sessionMdMtime = null;
  if (found && config.state === 'scaffold') {
    try {
      sessionMdMtime = statSync(path.join(cwd, '.claude', 'state', 'session.md')).mtimeMs;
    } catch {
      sessionMdMtime = null;
    }
  }

  const store = sessionStore(sessionId);
  // warned: problem strings already warned about this session. An old `{ warned: true }` store is
  // ignored (not an array), so at worst one problem is warned about once more.
  const { costLine, warning, block, problems, warnedAfter } = decideStop({
    config,
    found,
    entries,
    sessionMdMtime,
    warned: store.get().warned,
    cwd,
  });

  if (block) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `nauraiz-dev strict: ${problems.join('; ')}. Run the gate / write the handoff, then stop.`,
    }));
    return;
  }

  process.stdout.write(JSON.stringify({ systemMessage: costLine + (warning ? `\n⚠ ${warning}` : '') }));
  if (warning) {
    try { store.set({ warned: warnedAfter }); } catch { /* a failed write only means we may warn again */ }
  }
}

try {
  await main();
} catch {
  // never block a stop because the hook itself failed
}
process.exitCode = 0; // let stdout flush rather than process.exit()
