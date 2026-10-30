# nauraiz-dev design

What this plugin is for, what it deliberately is not, and the decisions behind 0.1.0 and 0.2.0.

## Why it exists

Two developers can install the same model and the same plugins and get very different
results. The difference is rarely the model. It is the working method around it: whether
the task is understood before anything is built, whether only the right context is
loaded, whether the work is checked against real command output before it ships, and
whether what was learned survives the end of the session.

That method usually lives in one person's head, in a `.claude/` folder shaped differently
in every repo, and in prompts written by hand for each task. `nauraiz-dev` packages it so
a team gets it on day one. It layers on top of
[superpowers](https://github.com/obra/superpowers) rather than replacing it.

## Goals

1. One install at user scope gives, in any repo: a cheap session-start context, protected
   paths, plan-scoped edits, a check that the gate ran after the last edit, and a handoff
   that survives compaction and the end of the session.
2. One `init` per project writes `.claude/nauraiz-dev.json`, a CLAUDE.md under 200 lines,
   and (optionally) a memory scaffold: `knowledge/`, `rules/`, `state/`.
3. The system improves itself over time: lessons become dated knowledge and rules,
   memory is pruned, relevant skills are suggested with their context cost (shipped in 0.2.0).
4. Every claim about the plugin is measured on a real repo before it is published.
5. Windows and macOS behave the same.

## Non-goals

- Not a fork of superpowers. Its skills are called, not copied.
- Not a memory runtime: no database, worker process or MCP server. Files only.
- No mandatory screenshots, browser comparisons or live logins.
- No ceremony documents, ledgers, receipts or token logs in the user's repo.
- Two agents at most, not an agent pack.

## Anti-goals (a failure even if it works)

- A session bootstrap over about 1,500 tokens, or any context injected twice.
- Blocking a developer's process step by default. Rigid process gets ripped out; the
  default warns once, and blocking is opt-in per project.
- Unsourced numbers in the README or anywhere else.
- Machine-specific paths committed to a repo. They belong in a git-ignored `.local.json`.
- Hooks that take seconds on every edit.

## Platform facts the design rests on

- A plugin cannot ship an always-loaded CLAUDE.md, so always-on context comes from
  `SessionStart` and `SubagentStart` hooks, or from files `init` writes into the project.
- A plugin cannot make another plugin's skill fire. It can preload skills into its own
  agents, inject instructions through hooks, or make its own agent the main thread.
- Only hooks are enforced. CLAUDE.md, rules and skills are advice.
- Subagents do not inherit CLAUDE.md, so project rules reach them through `SubagentStart`.
- `PreCompact` can block but cannot add context, so the "write the handoff" reminder is
  shown when the session resumes after compaction.
- Skill descriptions share a small listing budget, so the plugin ships few skills with
  short, trigger-first descriptions.

## Decisions in 0.1.0

- **Three enforcement levels.** `advisory` adds context only. `guided` (the default `init`
  writes, and the level of any config that names none) denies protected paths, asks before
  edits outside the plan's Allowed list, and warns once on a skipped gate or a stale
  handoff. `strict` also forces one more turn at Stop and blocks a manual `/compact` until
  the handoff is current. A repo with no config gets context only.
- **Plans are plain Markdown** with `branch:` frontmatter and a `### Allowed` list, found
  by matching the current branch. No plan means no scope ask.
- **Patterns follow gitignore semantics**, including directory patterns. `.env*` is always
  protected once a config exists, and still protected when the config file is unreadable.
- **Edits to the plugin's own bookkeeping** (state files, the handoff, plans) never count
  as work and never trigger the scope ask.
- **Errors never block the user.** Every hook fails open on its own errors, but a failed
  plan lookup never removes protected-path denies.
- **Node `.mjs` hooks only, zero dependencies**, with explicit timeouts.
- **Two state modes.** `scaffold` keeps `session.md`, `backlog.md` and `completed.md`;
  `none` keeps the handoff inside the branch's plan, for teams that do not want state files.

## Why 0.2.0

0.1 was safe and kept a session on track, but it did not change how Claude works. Three
flow tests on a real project showed what was missing:

- No run asked the owner anything before building, though every issue had an open
  decision and touched a shared layer.
- Two of the three runs wrote an owner approval into the plan that the owner never gave.
- Superpowers skills were not invoked in the runs that recorded skills; only the
  project's own task skills ran.
- One run duplicated a colleague's open pull request, because nothing checked who owned
  the issue.
- Trying the plugin dirtied the repo, and the project's own scope check counted the files.
- Long Opus runs read very large amounts of cached context, most of it exploration the
  main thread did itself.

0.2.0 is built around those findings. Its goals: ask before building when it matters,
never record an approval the owner did not give, never start on an issue someone else
owns, choose the process for each phase without running two, let a developer try the
plugin without changing a tracked file, turn the repetitive end of a task into skills,
and spend fewer main-thread tokens, not more.

## Decisions in 0.2.0

- **Ask only when it matters.** `grill` searches the repo and the issue first, then asks
  only what the repo cannot answer and where a wrong guess changes what gets built. It
  always asks when the issue has an open decision, the work touches a shared path, or the
  plan template requires an approval. Never more than three questions in a round, each
  with a recommendation and the cost of being wrong. Small tasks get no round.
- **Headless never asks.** With no one to answer, `grill` writes each question and its
  recommended answer under "Decisions to confirm" in the plan and proceeds on the
  recommendation. The report shows what was assumed.
- **Approvals are the owner's, never inferred.** An `*_approval` field is
  `pending owner confirmation` unless the owner said yes in this session. A `PreToolUse`
  check asks (it never denies) when an edit to a plan records any other value; `ship`
  lists the non-pending values and lets the owner keep or reset each one.
- **Collision check before work.** `scripts/task/collision.mjs` reports assignees, open
  PRs that reference the issue and who pushed the branch, as a verdict: `free`, `ours`,
  `taken` or `unknown`. If `gh` is missing, offline or unauthenticated the verdict is
  `unknown` with the reason, never `free`.
- **One process per phase.** `start-task` routes each phase to the project's own skill
  when it has one, else to the matching superpowers skill, and says its picks in one
  line. The session header carries one line pointing at `start-task`, not the routing table.
- **Local-only mode.** A config with only `.claude/nauraiz-dev.local.json` is a full
  config (`mode: local`, `guided`). `init --local` writes that file, `settings.local.json`
  and git's exclude file, and never a tracked file, `.gitignore` included. The exclude
  file lives in the git common directory, so every worktree is covered. Because
  `CLAUDE.md` is untouched, the session header carries the gate names itself.
- **The gate is a script, not a habit.** `scripts/gate/run.mjs` runs the configured
  commands through the platform shell, reports exit codes, and treats a failing summary
  printed under exit code 0 as red. `${base}` resolves to `origin/<base>` when the local
  branch is missing or behind it, which fixes scope checks against a stale base.
- **Exploration moves off the main thread.** Wide reading goes to a cheaper `explore`
  model in a subagent that returns conclusions and line ranges; the main thread reads
  only those ranges. The Stop line now includes subagent tokens and elapsed minutes so
  the cost is visible.
- **`ship` is its own skill, owner-invoked.** Rebase, gate, approval settlement, PR body
  in the repo's own format, push, open the PR. It never merges, never force-pushes, and
  refuses when the remote branch is not the owner's.
- **`review` is one skill with two modes.** No argument: review the local branch through
  the `reviewer` agent, which reads a diff file rather than having the diff pasted into
  the main thread. With a PR number: gate, review notes, never an approval.
- **`measure` is capped and plain.** Two headless arms, same model, fresh clone, one run
  each, a per-arm budget. Both arms get the same prompt a developer would type, so the
  plugin has to earn its behaviour rather than being handed a special kickoff. A report is
  n=1 and says so.
- **The description budget is checked, not assumed.** All thirteen skills and both agents
  are measured with `claude plugin details`; the total must stay under 1,500 tokens.
- **Honest platform claims.** Windows gets a real interactive smoke test. macOS gets unit
  tests and plugin validation in CI only, and the README says so.

## Shipped

- 0.1.x: the five hooks, `init`, `setup`, `handoff`, config layers, the eval runner.
- 0.2.0: `start-task`, `grill`, `kickoff-prompt`, `gate`, `ship`, `review`,
  `capture-lesson`, `memory-hygiene`, `find-skills`, `measure`, the `implementer` and
  `reviewer` agents, local-only mode, `init --print`, the approval check, the collision
  check, the gate runner, and the extended cost line.

## Roadmap

- First published `measure` reports in `docs/measure/`, and the numbers in the README only
  from them.
- Measure how the skills trigger alongside superpowers loaded (the evals so far run
  without it).
- A real interactive session on macOS.
- A real icon.

Dates are not promised.
