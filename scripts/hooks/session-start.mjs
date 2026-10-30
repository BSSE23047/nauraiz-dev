#!/usr/bin/env node
// SessionStart hook (startup|resume|compact): inject a small project context (<= MAX_CONTEXT_CHARS).
// Never throws: any failure -> exit 0, no output.
import { loadConfig } from '../lib/config.mjs';
import { readStdinJson } from '../lib/stdin.mjs';
import { currentBranch } from '../lib/git.mjs';
import { findPlanForBranch } from '../lib/plan.mjs';
import { buildSessionContext } from '../lib/context.mjs';

async function main() {
  const input = await readStdinJson();
  const payload = input && typeof input === 'object' ? input : {};
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const source = typeof payload.source === 'string' ? payload.source : undefined;

  const { config, found, present, error } = loadConfig(cwd);

  let branch = null;
  try {
    branch = currentBranch(cwd);
  } catch {
    branch = null;
  }

  // A plan lookup failure means "no plan", never a missing context.
  let plan = null;
  if (found && config.state === 'none') {
    try {
      plan = findPlanForBranch(cwd, config.plan.dir, branch);
    } catch {
      plan = null;
    }
  }

  const additionalContext = buildSessionContext({ cwd, config, found, present, error, branch, plan, source });
  // A config problem can silently weaken protection, so the user sees it too, not only the model.
  process.stdout.write(JSON.stringify({
    ...(error ? { systemMessage: `nauraiz-dev: config problem — ${error}` } : {}),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  }));
}

try {
  await main();
} catch {
  // never block a session because the hook itself failed
}
process.exitCode = 0; // let stdout flush rather than process.exit()
