# Changelog

## 0.2.2 — 2026-10-31

- measure: the default allowed tools now include `Skill`, `Agent`, `AskUserQuestion` and `TodoWrite`, for both arms. Under `claude -p` a tool that is not allowed is denied, so the `with` arm's call to the plugin's own skill was refused and the plugin could not run its process.
- measure: `--max-tokens` counts weighted tokens: input + output + cache creation + 0.1 x cache read, rounded down. Cache reads were about 98% of the counted tokens and are weighted at about a tenth by plan and API limits, so the raw cap stopped runs far too early. The report header says "Token cap: N weighted tokens per arm (cache reads count 0.1)" and has `tokens (weighted: cache reads at 0.1)` and `tokens (raw)` rows. The suggested cap is now 1,500,000 weighted tokens per arm. This changes what an existing `--max-tokens` value means: the same number now allows far more raw tokens.
- measure: output tokens without a result line (a capped or killed arm) are estimated: per message the estimate keeps the larger of characters/4 (the text blocks plus the JSON length of the tool inputs) and the message's own usage figure, plus the sum of the `thinking_tokens` deltas over the stream; the real stream only carries the message_start value there. The report row says "(estimated)", and the weighted and raw token rows say "(includes estimated output)". With a result line its usage is used.
- measure: time without a result line is the last minus the first `timestamp` in the stream, shown as "(from stream timestamps)".

## 0.2.1 — 2026-10-31

- measure: `--max-tokens` per-arm token cap for subscription plans; `--budget` is optional when it is set (at least one cap is required; both can be given). The harness counts input, output, cache creation and cache read tokens from the stream and kills the arm at the cap; the report gets a `stopped at token cap` row and the cap in the header.
- measure: `--setup "<cmd>"` runs once in each clone before `claude` starts (its time and output are not part of the arm's numbers); a failing setup marks the run FAILED and skips both arms. The setup runs with the full environment and outside the allowed-tools list (package lifecycle scripts run), and is killed after `--timeout-min`.
- measure: on Linux and macOS the arms and the setup run in their own process group, and a timeout or the token cap kills the whole group (SIGTERM, then SIGKILL after 2 s); a setup that outlives `--timeout-min` no longer hangs the run. On Windows `taskkill /t /f` now runs before the child itself is killed, so a shell's descendants are no longer orphaned and left holding the clone.
- measure: exit 2 for every argument refusal (including an unreadable `--prompt-file`), exit 1 for a failure while running.
- measure: a report banner when the streamed count reached the token cap but the arm was not stopped; `--budget`/`--max-tokens` given without a value are refused.
- measure: `pnpm` and `yarn` are in the default allowed tools next to `npm` and `npx`.

## 0.2.0 — 2026-10-31

Skill-listing cost: about 937 tokens always-on for all 13 skills and both agents together, measured with `claude plugin details` on this branch (budget 1,500).

Breaking:

- Cost line wording changed: `tokens this session (main thread): output …` is now `tokens this session: main out …`, with subagent totals and the wall time appended (`· 24 min wall`, left out above 1440 minutes).
- Session-start line 2 changed: the triage line is replaced by the `start-task` line, which also names `/nauraiz-dev:ship` for push and PR.

New skills (10, 13 in total):

- `start-task`: identify the issue, collision check, base check, triage, ask when it matters, route the process, cheap exploration, plan, build, gate, report.
- `grill`: at most three grounded questions per round, each with a recommendation; always asks on open decisions, shared paths and required approvals; headless it records the questions as decisions instead.
- `kickoff-prompt`: an issue to a pasteable prompt, starting with a guard block that checks folder, branch and plugin header.
- `gate`: runs the configured gate through `scripts/gate/run.mjs`, reports real exit codes, treats a failing summary printed under exit 0 as red.
- `ship` (you only): collision check, rebase on a moved base, gate on the result, settle approval lines, PR body in the repo's own format, push, open the PR. Never merges.
- `review`: reviews the local branch through the `reviewer` agent and the gate, or a PR by number; writes notes, never an approval.
- `capture-lesson`: saves a gotcha as a dated lesson in the project's knowledge folder or auto-memory.
- `memory-hygiene`: finds stale or relative-dated memory entries and dead file references.
- `find-skills`: suggests installable skills for the stack; network needed, never installs.
- `measure` (you only): budget-capped headless A/B of one task with and without the plugin, written up as a report.

New agents: `implementer` (sonnet) and `reviewer` (opus, read-only).

Hooks and scripts:

- Local-only mode: a config with only `.claude/nauraiz-dev.local.json` loads as a full config (`mode: local`, `guided`, `.env*` protected).
- `init --local` writes only the local config, `.claude/settings.local.json` and git's exclude file; `init --print` prints every file instead of writing.
- `init` detects `check`/`verify`/`typecheck`/`e2e` scripts and Makefile targets, proposes the one-shot form when `test` runs a watcher, and fills `sharedPaths` from the project's own shared-path lists.
- New config keys: `sharedPaths` and `models.explore`.
- `PreToolUse` asks (never denies) before an edit to a plan records an `*_approval` that does not start with `pending`; compares before and after text, so an Edit that adds an approval line is caught.
- `scripts/task/collision.mjs`: assignees, open PRs that reference the issue, remote branch authors; verdict `free`, `ours`, `taken` or `unknown` (`gh` missing or offline is `unknown`, never `free`; so is a failed `git ls-remote` when `gh` found no owner).
- `scripts/gate/run.mjs`: runs gate commands in order, substitutes `${plan}` and `${base}`, `${base}` resolves to `origin/<base>` when the local branch is behind it. Exit codes: 0 pass, 1 a command failed, 2 no gate, 3 the runner itself failed. A config error is printed to stderr whatever the outcome.
- `SessionStart`: warns when superpowers is missing (reading `CLAUDE_CONFIG_DIR` when set) and when `mockupRoot` is outside the repo; local mode adds the gate names and the runner command with the plugin path spelled out.
- `Stop`: counts a gate-runner call as a gate run; cost line adds subagent tokens (cached per transcript file; `subagents partial` past 64 MB of new reads in one stop) and wall time.
- `PreToolUse`: an unreadable local-only config keeps the `.env*` deny, as an unreadable project config does. Edits under the git directory are bookkeeping (no scope ask, not counted as work).
- `init` no longer offers scripts whose name contains `watch` as gate commands; `init --local` over a tracked config writes only the keys that differ from it.
- `measure`: the `with` clone gets a guided local config even without `--local-config`; an arm whose `claude` exits non-zero with no result line fails the run; `gh api user` is no longer in the default allowed tools.
- `setup` recommends the user-scope install.

Evals: 11 of 13 cases passed on the release run; `ship-not-model-invoked` was re-run once after the session-start change (reply fixed, still 0.5 on an attempted Skill call); two cases added and not yet run (`grill-small-negative`, `start-task-taken-stops`). See evals/results/2026-10-31-summary.md.

Docs: README rewritten for 0.2.0; design notes list the 0.2.0 decisions. No measured numbers are published yet.

## 0.1.2 — 2026-10-30

- The Stop cost line names every total in plain words: `tokens this session (main thread): output 15.4k, cache read 3.16M, cache write 41k, input 82`.
- `init` ends by telling you to commit its setup files on their own, through the base branch, before starting a task: a task's scope check otherwise counts them.
- Fixed a test that hard-coded the plugin version (CI was red on 0.1.1; the plugin itself was unaffected).

## 0.1.1 — 2026-10-30

- Skills read templates and references through `scripts/show.mjs` instead of reading plugin files directly. A project whose own hook denies reads outside the repo (the plugin cache is outside every repo) blocked `init` in 0.1.0.
- `init` stops and says so when a project hook blocks a step, and offers the `extraKnownMarketplaces` entry teammates need to install the plugin from shared project settings.

## 0.1.0 — 2026-10-30

Hooks (all Node `.mjs`, explicit timeouts):

- `SessionStart`: context header, capped at 6000 characters; points unconfigured repos at `init` and `setup`.
- `PreToolUse`: deny protected paths, ask outside the plan's Allowed list (`guided`, `strict`).
- `SubagentStart`: inject project rules and gate command names.
- `Stop`: one-line token cost; warn once (`guided`) or block (`strict`) on a skipped gate or stale handoff.
- `PreCompact`: block manual compaction until the handoff is current (`strict` with `state: scaffold`).

Skills:

- `init` (user-only): write the project config, `CLAUDE.md` and memory scaffold.
- `setup` (user-only): check and fix the machine.
- `handoff`: write or refresh the session handoff.

Also: config loader with project and local layers, `templates/nauraiz-dev.json`, an eval suite and runner (`evals/run-local.mjs`), CI on Windows and macOS.

Behaviour worth knowing:

- Protected and Allowed patterns follow gitignore semantics: `dir/`, `/dir` and `dir` cover everything inside the directory. `.env*` therefore also covers directories such as a `.env/` virtualenv.
- A config file that exists but cannot be read shows a system message and still protects `.env*`.
- A wrong-shaped value in `.local.json` is skipped and the project value kept.
- Gate runs count from any shell tool (Bash or PowerShell).
- Edits to state files, the handoff and plans are bookkeeping: they never count as work and never trigger the scope ask.
- The icon is a placeholder.
