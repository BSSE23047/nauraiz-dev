#!/usr/bin/env node
// PreToolUse hook (Write|Edit|MultiEdit|NotebookEdit): in guided/strict, deny protected paths, ask
// before a plan records an owner approval, and ask outside the plan's Allowed list. Advisory never
// denies or asks. An unreadable project config still denies .env* and still asks about approvals.
// Runs on every edit, so it stays cheap and never throws: any failure -> exit 0, no output.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { readStdinJson } from '../lib/stdin.mjs';
import { currentBranch } from '../lib/git.mjs';
import { findPlanForBranch } from '../lib/plan.mjs';
import { decideEdit, isPlanFile } from '../lib/decide-edit.mjs';
import { toRelative } from '../lib/paths.mjs';

const MAX_READ_BYTES = 2_000_000;

/** Current text of the file, or undefined when it is missing, too large or unreadable (fail open). */
function readCurrent(cwd, filePath) {
  try {
    const abs = path.resolve(cwd, filePath);
    if (statSync(abs).size > MAX_READ_BYTES) return undefined;
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** Apply Edit/MultiEdit replacements in order; null when one does not match (the tool would fail anyway). */
function applyEdits(text, edits) {
  let out = text;
  for (const e of edits) {
    if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string' || !e.old_string) return null;
    const at = out.indexOf(e.old_string);
    if (at === -1) return null;
    const replaceAll = e.replace_all === true;
    let next = '';
    let from = 0;
    for (let i = at; i !== -1; i = replaceAll ? out.indexOf(e.old_string, from) : -1) {
      next += out.slice(from, i) + e.new_string;
      from = i + e.old_string.length;
    }
    out = next + out.slice(from);
  }
  return out;
}

/**
 * What the file will contain after the tool runs (`newText`) and what it contains now (`oldText`).
 * Write: content vs the current file. Edit/MultiEdit: the replacements applied to the current file; if the
 * file cannot be read or an edit does not apply, just the new strings joined (no `oldText`).
 * Anything else (NotebookEdit): no text. Reads the file only for plan files.
 */
function textsOf(toolInput, cwd, filePath, isPlan) {
  const current = () => (isPlan ? readCurrent(cwd, filePath) : undefined);
  if (typeof toolInput?.content === 'string') {
    return { newText: toolInput.content, oldText: current() };
  }
  const edits = Array.isArray(toolInput?.edits) ? toolInput.edits
    : typeof toolInput?.new_string === 'string' ? [toolInput] : null;
  if (!edits) return {};
  const oldText = current();
  const applied = typeof oldText === 'string' ? applyEdits(oldText, edits) : null;
  if (applied !== null) return { newText: applied, oldText };
  return { newText: edits.map((e) => (typeof e?.new_string === 'string' ? e.new_string : '')).join('\n') };
}

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
    // The project file exists but is unreadable: the user opted in, so keep the always-on .env* deny
    // and the approval ask, and nothing else (no scope ask: no plan is looked up) until the file is
    // fixed. SessionStart reports the error.
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

  const isPlan = isPlanFile(toRelative(cwd, filePath), config, cwd);
  const { newText, oldText } = textsOf(toolInput, cwd, filePath, isPlan);
  const { decision, reason } = decideEdit({ cwd, filePath, config, found: true, plan, newText, oldText });
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
