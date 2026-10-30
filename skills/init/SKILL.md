---
name: init
description: "Set up nauraiz-dev in this project: detect the stack and gate commands, write .claude/nauraiz-dev.json, a CLAUDE.md under 200 lines and the memory scaffold. Use once per repo, or to re-detect. Not for day-to-day tasks."
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/init/detect.mjs" *) Read Write Edit Glob
---

# init

Adopt nauraiz-dev in the current repo. Templates are in `${CLAUDE_PLUGIN_ROOT}/templates/`.

Two limits apply to every step:

- Show a diff and wait for a yes before changing any file that already exists. New files
  can be written directly.
- Touch nothing outside `.claude/`, `CLAUDE.md` and `.gitignore`.

## Steps

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/init/detect.mjs" .` and show the JSON it
   prints. Do not guess past it: if `gate` is empty, say so; never invent gate commands.

2. Ask the user exactly two things, in one message, each with a recommendation:
   - `state`: `scaffold` (state files in `.claude/state/`, plans in
     `docs/superpowers/plans/`) or `none` (no state files; plans in `.work/tasks/` carry
     a Handoff). Recommend `none` if `hasWorkTasks` is true, otherwise `scaffold`.
   - `enforcement`: `advisory` (context only, never blocks), `guided` (blocks protected
     paths, asks outside the plan, warns once) or `strict` (blocks instead of warning).
     Recommend `guided`.

3. Write `.claude/nauraiz-dev.json` from `templates/nauraiz-dev.json`:
   - `state` and `enforcement` from step 2; `gate` and `protectedPaths` from detect;
     `branch.base` = `baseBranch`; `plan.dir` = `docs/superpowers/plans` for
     `scaffold`, `.work/tasks` for `none`.
   - Re-detecting (the file exists): start from it. `gate` and `protectedPaths` are the
     union of existing and detected entries; never remove or rewrite an existing gate
     command or protected path. Show the diff.
   - `scopeAsk`: see step 6.
   - No `{{` may remain. Keep `$comment`.
   - If the user named a mockup root or another machine-specific path, write it to
     `.claude/nauraiz-dev.local.json` as `{ "mockupRoot": "<path>" }`, never to the
     committed file.
   - Make sure `.gitignore` ignores `*.local.json`; add the line if it is missing.

4. CLAUDE.md:
   - If `claudeMd.exists` is false, write `CLAUDE.md` from `templates/CLAUDE.md`.
   - If it is true, never replace it. Propose a diff that adds only the "Commands and
     gate" and "Session discipline" sections from the template (skip any the file already
     covers). If the result would pass 200 lines, say so and suggest what to move into
     `.claude/knowledge/`.
   - `{{stack}}`, `{{baseBranch}}`, `{{enforcement}}` and `{{planDir}}` are the values
     from detect and step 3. Fill the rest from the repo, not from guesses:
     `{{projectName}}` and `{{description}}` (one or two sentences) come from the README
     or manifest;
     `{{layout}}` is a short list of the top-level folders that matter, one line each;
     `{{gate}}` is one line per gate entry: `` - `name`: `command` ``, or "None yet: add
     commands to `gate` in `.claude/nauraiz-dev.json`."; `{{protectedPaths}}` are the
     config's paths in backticks; `{{rules}}` is one line per file in `.claude/rules/`
     other than `README.md` (`` - `.claude/rules/<file>` — <its heading> ``), or "None yet."
   - Keep the `{{#scaffold}}` or the `{{#none}}` block to match `state`, delete the
     other, and delete the marker lines themselves. No `{{` may remain.

5. If `state` is `scaffold`, create whichever of these are missing, copied from the
   templates of the same name, and leave existing ones alone:
   `.claude/knowledge/README.md`, `.claude/rules/README.md`, `.claude/state/session.md`,
   `.claude/state/backlog.md`, `.claude/state/completed.md`. For `none`, create none.

6. If `existingPreToolUseHook` is true, set `"scopeAsk": false` in the config and tell
   the user why: the project already has a PreToolUse hook that sees edits, and two hooks
   asking about the same edit means a double prompt. nauraiz-dev still denies protected
   paths (in guided and strict); it only stops asking about edits outside the plan.
   Otherwise leave `"scopeAsk": true`.

7. Print every file written, changed or left alone, and anything the user should still
   fill in by hand (an empty gate, a vague description). Then tell them the next step:
   start a new Claude Code session, so the hooks pick up the config and CLAUDE.md.
