#!/usr/bin/env node
// PreToolUse hook (Write|Edit|MultiEdit|NotebookEdit): in guided/strict, deny protected paths and
// ask outside the plan's Allowed list; advisory never denies or asks. An unreadable project config
// still denies .env*. Runs on every edit, so it stays cheap and never throws: any failure -> exit 0, no output.
import { loadConfig } from '../lib/config.mjs';
import { readStdinJson } from '../lib/stdin.mjs';
import { currentBranch } from '../lib/git.mjs';
import { findPlanForBranch } from '../lib/plan.mjs';
import { decideEdit } from '../lib/decide-edit.mjs';

async function main() {
  const input = await readStdinJson();
  if (!input || typeof input !== 'object') return;
  const toolInput = input.tool_input;
  const filePath = toolInput?.file_path ?? toolInput?.notebook_path;
  if (typeof filePath !== 'string' || !filePath) return;

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const { found, present, config: loadedConfig } = loadConfig(cwd);
  let config = loadedConfig;
  let plan = null;
  if (!found && present) {
    // The project file exists but is unreadable: the user opted in, so keep the always-on .env* deny,
    // and nothing else (no plan ask) until the file is fixed. SessionStart reports the error.
    config = { ...config, enforcement: 'guided', protectedPaths: ['.env*'] };
  } else {
    if (!found || config.enforcement === 'advisory') return;
    // A plan lookup failure means "no plan", never "no protection".
    try {
      plan = findPlanForBranch(cwd, config.plan.dir, currentBranch(cwd));
    } catch {
      plan = null;
    }
  }

  const { decision, reason } = decideEdit({ cwd, filePath, config, found: true, plan });
  if (decision === 'allow') return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}

try {
  await main();
} catch {
  // never block an edit because the hook itself failed
}
process.exitCode = 0; // let stdout flush rather than process.exit()
