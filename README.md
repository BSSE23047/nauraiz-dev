# nauraiz-dev

A Claude Code plugin for the way work gets done: it checks who owns an issue, asks the owner what only the owner can answer before building, runs a gate that reads real exit codes, and keeps memory that survives the session. It layers on [superpowers](https://github.com/obra/superpowers). Version 0.2.0: five hooks, thirteen skills, two agents.

## Install

At user scope, so every folder you open shows the session header:

```
claude plugin marketplace add BSSE23047/nauraiz-dev
claude plugin install nauraiz-dev@nauraiz-dev --scope user
```

Inside a session the same two steps are `/plugin marketplace add BSSE23047/nauraiz-dev` and `/plugin install nauraiz-dev@nauraiz-dev`.

Needs Node 20 or newer on the PATH and Claude Code. The plugin depends on `superpowers@claude-plugins-official`. If install reports a cross-marketplace dependency error, add `"allowCrossMarketplaceDependenciesOn": ["claude-plugins-official"]` to `~/.claude/settings.json` and install again.

Then run `/nauraiz-dev:setup` once per machine. It checks Node, Claude Code, superpowers, that the hooks are registered once and that auto-memory is on.

## Set up a project

Two ways. Pick one per project.

| | `/nauraiz-dev:init` | `/nauraiz-dev:init --local` |
| --- | --- | --- |
| For | A repo you own, or where the team agrees to share the setup. | A shared repo where you want to try the plugin without committing anything. |
| Writes | `.claude/nauraiz-dev.json`, a `CLAUDE.md` under 200 lines, and optionally the memory scaffold (`knowledge/`, `rules/`, `state/`). | `.claude/nauraiz-dev.local.json`, `.claude/settings.local.json`, and git's own exclude file. Nothing else. |
| Tracked files | Created, with a diff shown and a yes asked before any existing file changes. | Never touched. `CLAUDE.md` and `.gitignore` are left alone; the files above are hidden through `<git-common-dir>/info/exclude`, which every worktree of the repo shares. |
| Each developer | Gets the same config from the repo. | Runs it once on their own machine. |

In local mode the session header adds the gate command names and the "read real exit codes" rule, because there is no `CLAUDE.md` to carry them.

`/nauraiz-dev:init --print` prints every file it would write, with paths, and writes nothing. It is the way to set up from CI or from `claude -p`.

`init` detects your stack and offers the gate commands it finds (build, test, and npm scripts named like `check`, `verify`, `typecheck` or `e2e`, Makefile `check` and `test` targets). When `test` would start a watcher, it proposes the one-shot form. It never invents a gate command.

## The skills

Thirteen. Skills that are not marked "you only" can also fire from a request or from another skill; the four marked "you only" run only when you type the command.

| Skill | Use it to | Invoked by |
| --- | --- | --- |
| `/nauraiz-dev:start-task` | Start work on an issue or feature: check who owns it, check the base branch, size the task, ask what matters, route to the right process, plan, build, gate, report. | you, or Claude on the first substantive request |
| `/nauraiz-dev:grill` | Ask the few questions that change what gets built: one round of at most three, each with a recommendation. | Claude, from `start-task`, or you |
| `/nauraiz-dev:kickoff-prompt` | Turn an issue into a prompt for a fresh session: guard block, branch, files, decisions, gate, stops, model, budget. | you, or Claude when asked |
| `/nauraiz-dev:gate` | Run the project's gate and report the real exit codes and last lines of output. | you, or Claude before a report or commit |
| `/nauraiz-dev:review` | Review the local branch before a PR (reviewer agent on the diff, plus the gate), or review a pull request by number. Writes notes, never an approval. | you, or Claude when asked to review |
| `/nauraiz-dev:ship` | Rebase on a moved base, re-run the gate, settle approval lines, write the PR body in the repo's own format, push, open the PR. Never merges. | **you only** |
| `/nauraiz-dev:capture-lesson` | Save a gotcha as a dated lesson in the project's knowledge folder (or auto-memory). | you, or Claude when asked to remember something |
| `/nauraiz-dev:memory-hygiene` | Find stale or relative-dated memory entries and dead file references, and clean them up. | you, or Claude when asked |
| `/nauraiz-dev:find-skills` | Suggest installable skills for the project's stack. Needs network, never installs anything. | you, or Claude when asked |
| `/nauraiz-dev:handoff` | Write or refresh the session handoff: goal, done, next, open questions, files in play. | you, or Claude when you wrap up |
| `/nauraiz-dev:measure` | Run one task twice, headless, with and without the plugin, under a spending cap, and write a report. | **you only** |
| `/nauraiz-dev:init` | Set up a project (above). | **you only** |
| `/nauraiz-dev:setup` | Check and fix the machine. | **you only** |

Two agents back them: `implementer` (one task per dispatch, test first, verifies before it reports) and `reviewer` (read-only, fresh context, findings ranked by severity).

`claude plugin details` reports about 940 tokens for the skill and agent listing (all thirteen skills and both agents), which is in every session; the plugin's own budget for it is 1,500. That is not the whole always-on cost: the `SessionStart` header (up to 6,000 characters) is added to every session, and `SubagentStart` injects the project's rules into each subagent. The header's size has not been measured, so no number is given for it.

## What it asks before building, and why

Triage first: a typo or one-line fix gets no questions. For anything bigger, `start-task` runs `grill`, which searches the repo and the issue first and asks only what the repo cannot answer and where a wrong guess changes what gets built. It always asks, before the plan, when:

- the issue has an open decision ("Decisions needed", "decide", "confirm", "TBD");
- the work touches a path the project marks as shared (`sharedPaths`, or a shared layer found at `init`);
- the project's plan template requires a recorded approval.

At most three questions in a round, each with a recommended answer and the cost if the recommendation is wrong. Headless (`claude -p`, no one to ask), it does not ask: it writes each question and its recommended answer into the plan under "Decisions to confirm" and goes on with the recommendation.

The reason, from the author's own use on a real project (observations, not measurements): in real runs, Claude built before asking, recorded approvals the owner had not given, and once duplicated a colleague's open pull request. So:

- **Collision check.** Before work starts, `start-task` and `ship` look at who is assigned, who has an open PR that references the issue, and who pushed the branch. If it is someone else's, they stop and tell you who and where. If `gh` is missing, offline or not signed in, or the remote branch cannot be checked, the answer is "unknown", never "free", and you are asked.
- **Approvals.** An `*_approval` field in a plan is `pending owner confirmation` unless you said yes in this session; then it quotes the date and your words. A hook asks before an edit writes any other value into a plan.
- **Base check.** It says how many commits the branch is behind `origin/<base>`, and the gate compares against `origin/<base>` when the local branch is stale.

## Hooks

All five are plain Node scripts with explicit timeouts. A hook never throws: on any error it exits 0 and stays silent.

| Event | What it does | Levels |
| --- | --- | --- |
| `SessionStart` | Injects a short header: version, enforcement level, one line pointing to `start-task`, and the session state or current plan handoff if there is one. Capped at 6000 characters. Without a project config it says to run `init` or `setup`. Warns when superpowers is missing, and when `mockupRoot` points outside the repo. A config that cannot be read is named in the header and shown to you as a system message. | all |
| `PreToolUse` (Write, Edit, MultiEdit, NotebookEdit) | Denies edits to protected paths (`.env*` is always protected once a config exists). Asks before editing a path outside the branch plan's `### Allowed` list, except the plan itself, `.claude/state/` and `.work/handoff.md`. Asks, never denies, before an edit to a plan records an approval whose value does not start with `pending`. | `guided`, `strict`. `advisory` never denies or asks. An unreadable project config still denies `.env*`. |
| `SubagentStart` | Injects the project's rules and the gate command names into subagents, which do not inherit `CLAUDE.md`. Silent without a project config. | all, once a config exists |
| `Stop` | Prints a one-line token count for the main thread, for subagents when their transcripts are found, and the elapsed minutes. If files were edited and a configured gate was not run afterwards (the `gate` skill counts), or (with `state: scaffold`) `session.md` is older than the last edit, it warns once per problem (`guided`) or forces one more turn (`strict`). Edits to `.claude/state/`, `.work/handoff.md` and the plan directory do not count as edits. | cost line: all. Warn: `guided`. One more turn: `strict`. |
| `PreCompact` | Blocks a manual `/compact` until `session.md` is newer than the last edit (edits counted as for `Stop`). Does nothing otherwise. | `strict` with `state: scaffold` only |

### Enforcement levels

- `advisory`: context and the cost line only. Nothing is denied, asked or blocked. This is also what a repo with no config gets.
- `guided`: the default `init` writes, and the level of a local-only config. Denies protected paths, asks outside the plan, asks before an approval is recorded, warns once on a skipped gate or a stale handoff. The gate check needs a configured `gate`; the handoff check needs `state: scaffold`.
- `strict`: everything in `guided`, and when the gate has not run after the last edit or the handoff is stale, a `Stop` forces one more turn to run the gate / write the handoff (the stop after that goes through, so it cannot loop), and a manual `/compact` is blocked until the handoff is current.

## Configuration

Project settings live in `.claude/nauraiz-dev.json`, committed with the repo and written by `init`. Machine-specific values (for example a `mockupRoot` path) go in `.claude/nauraiz-dev.local.json`, which is git-ignored and merged over the project file. With only the local file present, it is the whole config (`mode: local`). A starting point is [templates/nauraiz-dev.json](templates/nauraiz-dev.json).

| Key | Meaning | Default |
| --- | --- | --- |
| `enforcement` | `advisory`, `guided` or `strict` (above). | `guided` when a config exists without it |
| `state` | `scaffold` (three state files plus knowledge and rules) or `none` (plans in `plan.dir` carry the handoff). | `none` |
| `scopeAsk` | Ask before editing outside the plan's Allowed list. `init` sets it to `false` if you already have your own PreToolUse hook. | `true` |
| `gate` | Named commands that make up your gate, for example `{ "build": "npm run build" }`. `${plan}` and `${base}` are substituted. | `{}` |
| `protectedPaths` | Globs the PreToolUse hook denies, with gitignore semantics: `dist/`, `/dist` and `dist` all cover `dist/a.js`. | `[]`, plus `.env*` |
| `sharedPaths` | Globs for shared or framework-owned code. Edits there are allowed, but `grill` always asks first. | `[]` |
| `models` | Model per kind of work: `small`, `normal`, `large`, `review`, `fix-round`, `explore`. | sonnet, opus, opus, opus, sonnet, haiku |
| `branch` | `base`, `pattern`, `merge` for branch naming and merging. | `main`, `feature/${issue}-${slug}`, `merge` |
| `plan` | `dir` where plans live, and an optional `template`. | `.work/tasks`, none. With `state: scaffold` and no `plan.dir` set, `dir` is `docs/superpowers/plans`. |
| `mockupRoot` | Local folder of design mockups. Set it in `.local.json`; it is shown at session start. | unset |
| `pr` | Section headings for pull request descriptions, used when the repo has no recent PR by you to copy the format from. | Summary, Steps ↔ commits, Gate output, Decisions to confirm, Risks, Unverified |

The gate runner (`scripts/gate/run.mjs`, called by the `gate` skill) runs each `gate` command in order through the platform shell, prints a table with exit code and duration plus the last lines of each command, and exits non-zero if any failed. A command that exits 0 but prints a failing summary (`FAIL  1 file(s)`, `Tests  1 failed`, `# fail 1`) is reported red. It writes nothing into your repo.

## Numbers

None yet. Every number this plugin quotes will come from a `measure` report in `docs/measure/`, and there are no reports there yet.

`/nauraiz-dev:measure` runs one task twice, headless: once with this plugin switched off and once with it on, each in a fresh clone, on the same model, with the same plain prompt a developer would type:

> Work on issue #N on branch B. Commit locally, do not push or open a PR. Report what you built, the gate results, decisions to confirm, risks and anything unverified.

Each arm runs once and is capped by `--max-budget-usd` (default 3 USD). The report lists time, output, cache read and cache write tokens, gate result, questions asked (headless: written as decisions), approvals recorded, skills invoked, files touched, and the exact commands. One run per arm is n=1: a report is a data point, not a benchmark.

## Platforms and testing

- Windows: a real interactive smoke test was run on 0.1.0 ([docs/notes/smoke-0.1.0.md](docs/notes/smoke-0.1.0.md)). 0.2.0 has unit tests, `claude plugin validate` and one eval run, but no interactive smoke test yet.
- macOS: unit tests and `claude plugin validate` in CI only. No real session has been run on macOS.

CI runs on Windows and macOS with Node 22 and 24.

## Known limits

- The protected-path deny covers the Write, Edit, MultiEdit and NotebookEdit tools. It does not see shell writes such as `echo > .env`.
- Path matching is case-insensitive on Windows only.
- Path patterns follow gitignore directory semantics: a pattern that matches a directory covers everything under it, and a pattern without a `/` matches a name at any depth.
- A project config that cannot be read shows a system message at session start; until it is fixed, only `.env*` stays protected, and nothing is asked or blocked otherwise.
- Config is read from the session's working directory. There is no search of parent directories.
- The approval check looks at plans under `plan.dir` (and Markdown files with frontmatter under a `/tasks/` or `/plans/` folder). It asks; it cannot know whether you really said yes.
- The collision check needs the GitHub CLI, signed in. Without it the answer is "unknown" and you are asked.
- Only hooks are enforced. Skills and `CLAUDE.md` are advice the model can ignore.
- The evals ran without superpowers loaded, so how the skills trigger alongside superpowers is not yet measured. See [the eval summaries](evals/results/).
- Whether `start-task` improves outcomes is not yet measured. That is what `measure` is for.
- The plugin icon is a placeholder.

## What this is not

- Not a fork or replacement of superpowers. It calls superpowers' skills and does not copy them.
- Not a memory runtime: no database, worker process or MCP server. Files only.
- Not a document-generation framework: no sprint docs, personas or ceremony files.
- Not a general agent pack: two agents.
- Not for other harnesses. Claude Code only.
- Does not block your work by default: it denies only protected paths and asks before out-of-plan edits. It warns once on a skipped gate; forcing another turn is opt-in with `strict`.
- It never requires screenshots, browser comparisons or live-login steps. A project may add them to its own gate.

The design and its reasoning are in [docs/design.md](docs/design.md).

## Licence

MIT. See [LICENSE](LICENSE).
