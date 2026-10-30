# Changelog

## 0.2.0 — 2026-10-31

Skill-listing cost: about 937 tokens always-on for all 13 skills and both agents together, measured with `claude plugin details` on this branch (budget 1,500).

Breaking:

- Cost line wording changed: `tokens this session (main thread): output …` is now `tokens this session: main out …`, with subagent totals and elapsed minutes appended.
- Session-start line 2 changed: the triage line is replaced by the `start-task` line.

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
- `scripts/task/collision.mjs`: assignees, open PRs that reference the issue, remote branch authors; verdict `free`, `ours`, `taken` or `unknown` (`gh` missing or offline is `unknown`, never `free`).
- `scripts/gate/run.mjs`: runs gate commands in order, substitutes `${plan}` and `${base}`, `${base}` resolves to `origin/<base>` when the local branch is behind it.
- `SessionStart`: warns when superpowers is missing and when `mockupRoot` is outside the repo; local mode adds the gate names.
- `Stop`: counts a gate-runner call as a gate run; cost line adds subagent tokens and elapsed minutes.
- `setup` recommends the user-scope install.

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
