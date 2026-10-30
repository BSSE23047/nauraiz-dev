---
name: start-task
description: "Start work on an issue, branch or feature request: checks who owns the issue, asks before building, picks process and model, plans, builds, gates. Use on the first substantive request. Not for one-line fixes, typos, questions or PR review."
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" *) Bash(gh issue view *) Bash(git fetch *) Bash(git rev-list *) Bash(git branch --show-current) Read Glob Grep
---

# start-task

The loop for one task. Do the steps in order and do not write code before step 9. The
triage heuristic, routing table and plan rules: run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" skills/start-task/reference.md` at step 4
(never Read plugin files directly).

Config: `.claude/nauraiz-dev.json`, with `.claude/nauraiz-dev.local.json` over it. Keys:
`branch.base`, `branch.pattern`, `plan.dir`, `plan.template`, `models.*`, `sharedPaths`,
`gate`. No config: base `main`, plans in `.work/tasks`, models small `sonnet`, normal and
large `opus`, explore `haiku`.

Rules for every step:

- The owner decides. Never write that the owner approved, agreed or confirmed anything
  they did not say in this session.
- "Stop" and "ask" mean: end your turn with the question and wait. Do not continue on a
  guess.
- Never push, open a PR or merge unless the owner asked for it in this session.

## Steps

1. **Identify.** Issue number from the request, else from the branch name
   (`git branch --show-current`, `branch.pattern`; `feature/12-x` is issue 12). Run
   `gh issue view <n> --json title,body,assignees,labels,comments`. No issue number: the
   request is the spec. If `gh issue view` fails, say so and work from the request.

2. **Collision check.** With an issue number, even if `gh issue view` failed, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs" <n>` (add `--branch <name>`
   when the request names a branch) and read `verdict`. If the script cannot run or
   prints no `verdict`, treat it as `unknown`.
   - `taken`: **stop.** Tell the owner who and where: the `reason`, `otherAssignees`, each
     `openPRs` number, author and head, and `remoteBranch` name and authors. Do nothing
     more until the owner says to go on.
   - `unknown`: ask the owner whether to go on, quoting the `reason`. Wait.
   - `ours` or `free`: say the verdict in one line and go on.

3. **Base check.** `git fetch origin <base>` (`branch.base`); if it fails or there is no
   `origin`, say so and go on. Then `git rev-list --count HEAD..origin/<base>`. Not 0:
   say "<n> commits behind origin/<base>" and, if the branch has no commits of its own
   (`git rev-list --count origin/<base>..HEAD` is 0), add "recreate it on
   origin/<base>?" to that line. Go on; recreate only on a yes.

4. **Triage.** Size the task small / normal / large by `reference.md`. Say the size and the
   model `models.<size>` in one line; if this session runs another model, say so.
   Small: make the change, verify it (the relevant test or gate command), report, done.
   Skip steps 5 to 8.

5. **Ask when it matters.** Run the `grill` skill. It may end the turn to wait for answers,
   then hands back here.

6. **Route the process.** Pick one process per phase from the routing table in
   `reference.md` and say the picks in one line, e.g. "Process: grill →
   superpowers:writing-plans → superpowers:test-driven-development → gate". Invoke each
   with the Skill tool when its phase starts; never follow one from memory. Large: the
   Design phase runs the skill picked here. When `superpowers:brainstorming` offers to
   start `superpowers:writing-plans`, that is the Plan phase: use the Plan pick instead.

7. **Explore cheaply.** If understanding the task needs more than ~5 files, or any file
   over ~800 lines, dispatch the `Explore` subagent with its model set to `models.explore`
   (default `haiku`). Ask it for conclusions with file paths and line ranges, then read
   only those ranges yourself.

8. **Plan.** Write the plan by the plan rules in `reference.md`: `branch:` frontmatter,
   `### Allowed` listing every path you will edit, `## Decisions` (the owner's answers)
   and "Decisions to confirm".
   Any `*_approval` field is `pending owner confirmation` unless the owner said yes in this session; then quote the date and the owner's words.
   If any `### Allowed` entry matches `sharedPaths` and was not asked about, run `grill` again before building.

9. **Build, gate, report.** Build with the routed skill. Then run the `gate` skill, or
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" --plan <plan path>` (exit 0 all
   pass, 1 a failure, 2 no gate configured). Read the real exit code and table; never call
   anything green that failed or did not run. Report: what was built, the gate table,
   decisions to confirm, risks, anything unverified. Offer `ship` only if the owner
   authorised a PR in this session.
