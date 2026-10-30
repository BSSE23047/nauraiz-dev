#!/usr/bin/env node
// SubagentStart hook: subagents do not inherit CLAUDE.md, so inject the project's rules (<= MAX_CONTEXT_CHARS).
// Never throws: any failure -> exit 0, no output. No project config -> no output.
import { loadConfig } from '../lib/config.mjs';
import { readStdinJson } from '../lib/stdin.mjs';
import { buildSubagentContext } from '../lib/context.mjs';

async function main() {
  const input = await readStdinJson();
  const payload = input && typeof input === 'object' ? input : {};
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  const { config, found } = loadConfig(cwd);
  const additionalContext = buildSubagentContext({ cwd, config, found });
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext },
  }));
}

try {
  await main();
} catch {
  // never block a subagent because the hook itself failed
}
process.exitCode = 0; // let stdout flush rather than process.exit()
