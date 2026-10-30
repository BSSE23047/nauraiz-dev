---
name: init
description: "Set up nauraiz-dev in this project: detect the stack and gate commands, write .claude/nauraiz-dev.json, a CLAUDE.md under 200 lines and the memory scaffold. Use once per repo, or to re-detect. Pass --local to try it in a shared repo without changing any tracked file, or --print to show every file instead of writing it. Not for day-to-day tasks."
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/init/detect.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/init/exclude.mjs" *) Read Write Edit Glob
---

# init

Adopt nauraiz-dev in the current repo. Get each template's text with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" templates/<name>` (e.g. `templates/CLAUDE.md`).
Never Read plugin files directly: the project's own hooks may deny reads outside the repo.

Three limits apply to every step:

- Show a diff and wait for a yes before changing any file that already exists (not in
  `--print`, which writes nothing). New files can be written directly.
- Touch nothing outside `.claude/`, `CLAUDE.md` and `.gitignore`; `--local` is narrower (below).
- If a project hook blocks a step, stop and say which; never work around it.

## Modes

The mode comes from the arguments the user typed (`/nauraiz-dev:init --local`, `--print`);
they can be combined, and with neither it is project mode.

- `--local`: for a shared repo whose tracked files you must not change. Touch only
  `.claude/nauraiz-dev.local.json`, `.claude/settings.local.json` and git's exclude file
  (through the script below); never `CLAUDE.md`, `.gitignore`, `.claude/settings.json` or any
  tracked file. Skip steps 4 and 5. State is always `none`. Then run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/init/exclude.mjs" .claude/nauraiz-dev.local.json .claude/settings.local.json .work/`
  so git ignores all three (the plan folder `.work/` too).
- `--print`: do every step, but write nothing and run no exclude; print each file's path
  and full content instead, plus the patterns that would go to `exclude.mjs` (it makes them
  repo-root-relative). For headless runs.

## Steps

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/init/detect.mjs" .` and show the JSON it
   prints. Do not guess past it: if `gate` is empty, say so; never invent gate commands.

2. Ask the user these questions in one message, each with a recommendation:
   - `state` (not in `--local`): `scaffold` (state files in `.claude/state/`, plans in
     `docs/superpowers/plans/`) or `none` (no state files; plans in `.work/tasks/` carry
     a Handoff). Recommend `none` if `hasWorkTasks` is true, otherwise `scaffold`.
   - `enforcement`: `advisory` (context only, never blocks), `guided` (blocks protected
     paths, asks outside the plan, warns once) or `strict` (blocks instead of warning).
     Recommend `guided`.
   - Only if `offeredGate` or `testOneShot` is non-empty (both modes): offer each
     `offeredGate` entry as an extra `gate` command, and `testOneShot` in place of the
     `test` command, which would watch forever. Use only what the user accepts.

3. Write `.claude/nauraiz-dev.json` from `templates/nauraiz-dev.json`. In `--local` write the
   whole config (state `none`) to `.claude/nauraiz-dev.local.json` instead, without `$comment`:
   - `state` and `enforcement` from step 2; `gate`, `protectedPaths` and `sharedPaths` from detect;
     `branch.base` = `baseBranch`; `plan.dir` = `docs/superpowers/plans` for
     `scaffold`, `.work/tasks` for `none`.
   - Re-detecting (the file exists): start from it. `gate`, `protectedPaths` and `sharedPaths`
     are the union of existing and detected entries; never remove or rewrite an existing
     gate command or protected path. Show the diff. `--local`: a tracked
     `.claude/nauraiz-dev.json` is only a base and is never edited; start from an existing
     `.claude/nauraiz-dev.local.json` if there is one, else from the tracked file, and write
     the merged result to the local file.
   - `scopeAsk`: see step 6.
   - No `{{` may remain. Keep `$comment` (project mode).
   - If the user named a mockup root or another machine-specific path, write it as
     `mockupRoot` to `.claude/nauraiz-dev.local.json`, never to the committed file: merged
     into the existing keys, and in `--local` as one key of the full config.
   - `--local`: merge into `.claude/settings.local.json`, keeping every existing key: set
     `enabledPlugins["nauraiz-dev@nauraiz-dev"]` to `true` and `extraKnownMarketplaces["nauraiz-dev"]`
     to `{ "source": { "source": "github", "repo": "BSSE23047/nauraiz-dev" } }`.
   - Project mode: make sure `.gitignore` ignores `*.local.json`; add the line if missing.
   - Project mode: if `.claude/settings.json` enables `nauraiz-dev@nauraiz-dev` but has no
     `extraKnownMarketplaces.nauraiz-dev`, propose adding it (GitHub repo
     `BSSE23047/nauraiz-dev`) so teammates who pull the settings can install it.

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

6. If `existingPreToolUseHook` is true, set `"scopeAsk": false` and say why (the
   project's own edit hook already asks; protected paths are still denied). Otherwise
   leave `"scopeAsk": true`.

7. Print every file written, changed or left alone, and anything still to fill in by hand.
   Next steps: commit these setup files on their own, through the base branch and before
   any task branch (a task's scope check would count them), then start a new session.
   In `--local` nothing needs committing: say so, that the files are excluded locally, and
   that the gate reaches Claude through session start.
