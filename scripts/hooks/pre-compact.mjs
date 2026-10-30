#!/usr/bin/env node
// PreCompact hook. Emits nothing on stdout (PreCompact has no systemMessage/additionalContext;
// the post-compaction reminder lives in SessionStart source=compact).
// Only behaviour: in strict+scaffold repos, block a MANUAL /compact (exit 2 + stderr) while
// session.md is missing or older than the last edit (edits to bookkeeping files do not count).
// Auto-compaction is never blocked.
// Any internal failure -> exit 0.
import { statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { readStdinJson } from '../lib/stdin.mjs';
import { readTranscript, lastEditTs } from '../lib/transcript.mjs';
import { isBookkeeping } from '../lib/bookkeeping.mjs';

const MESSAGE = 'nauraiz-dev strict: session.md is older than your last edit; run /nauraiz-dev:handoff, then /compact.';

function shouldBlock(payload) {
  if (payload.trigger !== 'manual') return false;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const { config, found } = loadConfig(cwd);
  if (!found || config.enforcement !== 'strict' || config.state !== 'scaffold') return false;

  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  // Edits to bookkeeping files (state files, the plan) are not work: the handoff itself makes them.
  const exclude = (rel) => isBookkeeping(rel, config, cwd);
  const editTs = transcript ? lastEditTs(readTranscript(transcript), { cwd, exclude }) : null;
  if (editTs === null) return false;

  try {
    return statSync(path.join(cwd, '.claude', 'state', 'session.md')).mtimeMs < editTs;
  } catch {
    return true; // session.md missing
  }
}

try {
  const input = await readStdinJson();
  const payload = input && typeof input === 'object' ? input : {};
  if (shouldBlock(payload)) {
    process.stderr.write(MESSAGE + '\n');
    process.exitCode = 2;
  }
} catch {
  // never block a compaction because the hook itself failed
}
