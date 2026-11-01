---
name: start-task
description: "Start work on an issue, branch or feature request: checks who owns the issue, asks before building, picks process and model, plans, builds, gates. Use on the first substantive request. Not for one-line fixes, typos, questions or PR review."
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/task/preflight.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" *) Bash(gh issue view *) Bash(git fetch *) Bash(git rev-list *) Bash(git branch --show-current) Read Glob Grep
---

# start-task

The loop for one task. Do the steps in order and do not write code before step 9. The
routing table and plan rules live in `reference.md`; step 6 says when to read it (never
Read plugin files directly).

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
   (`git branch --show-current`, `branch.pattern`; `feature/12-x` is issue 12). Then make
   ONE call for steps 1 to 3: `node "${CLAUDE_PLUGIN_ROOT}/scripts/task/preflight.mjs" <n>`
   (add `--branch <name>` when the request names a branch, and
   `--branch <current branch>` when the issue number came from the current branch name).
   It prints JSON: `issue`
   (title, body, labels, state, comments; `null` if `gh issue view` failed), `collision`,
   `base`. Steps 2 and 3 read it; make no other `gh` or `git` call for them.
   No issue number: the request is the spec; run it without one and use only `base`.
   A number with `issue` null: say so and work from the request.

2. **Collision check.** With an issue number, even if `gh issue view` failed, read
   `collision.verdict`. If preflight cannot run, run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs" <n>` with the same flags
   instead; if that prints no `verdict` either, treat it as `unknown`.
   - `taken`: **stop.** Tell the owner who and where: the `reason`, `otherAssignees`, each
     `openPRs` number, author and `why` (linked, mention, url, branch or head), and each
     `remoteBranches` and `remoteBranch` name and authors. Nothing more until the owner says go on.
   - `unknown`: ask the owner whether to go on, quoting the `reason`. Wait.
   - `ours` or `free`: say the verdict in one line and go on.

3. **Base check.** Read `base`. `behind` null (`fetched` false, or the count failed): say its
   `reason` and go on. `behind` above 0: say "<n> commits behind origin/<base>" and, if `ahead`
   is 0 (no commits of its own), add "recreate it on origin/<base>?". Go on; recreate only on a yes.

4. **Triage.** Size the task and say the size and the model `models.<size>` in one line;
   if this session runs another model, say so. Small: one or two files, an obvious change
   (typo, copy, rename, one-line bug with a known cause). Normal: one area, about 3 to 10
   files, a clear design. Large: across areas, a new schema, API, shared seam or
   dependency, more than ~10 files, or an open design. Torn: pick the larger. Small: make
   the change, verify it (the relevant test or gate command), report, done. Skip steps 5
   to 8; never read `reference.md`.

5. **Ask when it matters.** Run the `grill` skill. It may end the turn to wait for answers,
   then hands back here.

6. **Route the process.** Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" skills/start-task/reference.md` once
   (routing table and plan rules, for steps 6 and 8). Pick one process per phase from the
   routing table and say the picks in one line, e.g. "Process: grill →
   superpowers:writing-plans → superpowers:test-driven-development → gate". Invoke each
   with the Skill tool when its phase starts; never follow one from memory. Large: the
   Design phase runs the skill picked here. When `superpowers:brainstorming` offers to
   start `superpowers:writing-plans`, that is the Plan phase: use the Plan pick instead.

7. **Explore cheaply.** If understanding the task needs more than ~5 files, or any file
   over ~800 lines, dispatch the `Explore` subagent with its model set to `models.explore`
   (default `haiku`). Ask it for conclusions with file paths and line ranges, then read
   only those ranges yourself.

8. **Plan.** Write the plan by the plan rules in `reference.md` (read at step 6): `branch:` frontmatter,
   `### Allowed` listing every path you will edit, `## Decisions` (the owner's answers)
   and "Decisions to confirm".
   Any `*_approval` field is `pending owner confirmation` unless the owner said yes in this session; then quote the date and the owner's words.
   If any `### Allowed` entry matches `sharedPaths` and was not asked about, run `grill` again before building.

9. **Build, gate, report.** Build with the routed skill. Then run the `gate` skill, or
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" --plan <plan path>` (exit 0 all
   pass, 1 a failure, 2 no gate configured). Run it once, from any folder in the project;
   it prints every command's exit code itself, so never append `echo $?`, pipes or `cd`.
   Re-run only after you changed code, or once with `--plan <path>` when a row says `no plan for this branch`. Read the table; never call anything green that
   failed or did not run. Report: what was built, the gate table, decisions to confirm,
   risks, anything unverified. Offer `ship` only if the owner authorised a PR this session.
