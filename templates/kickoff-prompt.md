Work only in {{absPath}}. Before anything else, run `pwd` and `git branch --show-current`, and check that this session's context has a line starting with `nauraiz-dev v{{version}} · enforcement={{enforcement}}`. If the directory is not {{absPath}} (the same directory in any path form counts, e.g. `D:\x` and `/d/x`), the branch is not `{{branch}}`, or that line is missing or different: stop and report what you found; do not cd, do not branch, do not edit anything.

Task: {{title}} ({{issueRef}})
Branch `{{branch}}`, based on `{{base}}`. Start with /nauraiz-dev:start-task.

## Read first

{{filesToRead}}

## Do not read

{{filesNotToRead}}

## Mockups and specs

{{mockups}}

## Decisions already made

{{decisionsMade}}

## Decisions to confirm

{{decisionsOpen}}

## Gate

{{gate}}

Run it with /nauraiz-dev:gate and read the real exit codes, never a grepped summary.

## Stop and ask when

- the collision check says the issue is taken, or cannot tell;
- a decision above is still open and someone can answer;
- the work needs a path outside the plan's `### Allowed`, or a protected path;
- the gate is still red after two fix attempts, or the budget is spent.
{{extraStops}}

## Never

- Push, open a PR or merge. Commit locally only.
- Record an approval the owner did not give: every `*_approval` value stays `pending owner confirmation` unless the owner says yes in that session; then quote the date and the owner's words.

Model: {{model}}
Budget: {{budget}}

## Report

What was built (files and commits), the gate table, decisions to confirm, risks, and anything unverified.
