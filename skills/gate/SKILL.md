---
name: gate
description: "Run the project's gate (its configured build, test and check commands) and report the real exit codes: before a report, a commit or a PR, or when asked to run the checks. Not for writing or fixing tests, or for one ad-hoc command."
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" *)
---

# gate

One call runs every gate command and reads each real exit code. A command that exits 0
but prints failures (`Tests  1 failed`, `# fail 2`) is marked failed. Trust the runner,
not a summary line.

"Stop" means: end your turn with the report and wait.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs"` in the repo root. Write it
   exactly like that, forward slashes included. Add `--plan <path>` when you know the
   task's plan (without it the runner looks for the plan of the current branch). Add
   `--only <name,name>` only when asked for some of the commands.
2. Read the exit code:
   - `0`: every command passed.
   - `1`: at least one failed: a non-zero exit, or `exit 0 but output reports failures`.
     A row failed with `no plan for this branch (pass --plan)` was not run: if a plan for
     this task exists, run again with `--plan <path>`; otherwise report it failed.
   - `2`: quote every `nauraiz-dev:` line it printed first. If any line other than
     `no gate configured …` names a config file, the config failed to load: say the file
     needs fixing, not that there is no gate, and stop. Otherwise no gate is configured:
     say so, point to `/nauraiz-dev:init` (it detects the gate commands), and stop.
3. Paste the runner's output verbatim (the table and every block), then one line:
   `Gate: pass` or `Gate: FAIL (<names>)`.
4. Never re-run a gate command by hand, pipe it or grep it, unless the runner reported
   that command failed; then run only that one, only to find the cause. A by-hand run is
   never the gate result: after a fix, run the runner again.
5. Never call anything green that failed or did not run. Called on its own: stop after
   the report. Called from another skill: hand the result back to it.
