---
name: measure
description: "Capped headless A/B of one task with and without this plugin, written up as a report. Only when the owner runs it; costs money or plan usage. Not for evals, benchmarks or repeat runs."
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/measure/run.mjs" *) Read Write Glob
---

# measure

Two `claude -p` runs on the same task: **without** (this plugin switched off, everything
else as usual) and **with** (`--plugin-dir` plus a pre-written local config). Each arm gets
a fresh clone and the same plain prompt, runs once, and is capped by tokens, by dollars, or by both (below).
The harness reads tokens, cost and time from the stream, runs the gate in each clone and
writes the report. Every number you quote later comes from that report.

"Stop" and "ask" mean: end your turn with the question and wait.

## Before anything runs

Ask the owner to confirm each of these in one message. Never start on a guess:

1. **Task.** The repo (git URL or path), the exact commit `<sha>` both arms start from,
   the issue number `N` and the branch name `B`. It should be small enough to finish in
   about 15 minutes.
2. **Prompt.** Default, filled in and shown back verbatim:
   `Work on issue #N on branch B. Commit locally, do not push or open a PR. Report what you built, the gate results, decisions to confirm, risks and anything unverified.`
   Both arms get exactly this text. The `with` arm therefore runs the whole `start-task`
   loop; headless, its questions come out as written decisions. The report's questions row
   counts AskUserQuestion calls only, so those written decisions are not in it.
3. **Model.** `sonnet` unless the owner names another.
4. **Cap per arm.** At least one is required; the harness refuses to run without one.
   - On a subscription plan (limits are in tokens, not dollars) use `--max-tokens`: default suggestion 2,000,000 per arm on sonnet. The harness counts input, output, cache creation and cache read tokens from the stream and kills the arm when the count reaches the cap; the arm keeps its partial stream, still gets the gate, and the report row `stopped at token cap` says yes. The count is checked per assistant message, so an arm can overshoot a little.
   - On API billing use `--budget` (`--max-budget-usd`): default 3 USD.
   - Both can be given; both then apply. Say the approximate totals: 2 x the cap (the approximate total cap: 2 x budget in USD, 2 x `--max-tokens` in tokens). Above 20 USD or 20,000,000 tokens per arm needs `--allow-high-budget`, and only on the owner's explicit say-so.
5. **Gate command** to run in each clone afterwards (the repo's own test command), an optional
   `--setup "<cmd>"` run once in each clone before `claude` starts (for example `npm ci`; its time and
   output are not part of the arm's numbers, and a failing setup stops the run before anything is spent),
   and an optional `--local-config <json file>` for the `with` clone. Without it the `with` clone
   gets `{ "gate": { "gate": "<cmd>" } }` from `--gate` (`{}` with no gate): guided local mode.
6. **Report path.** Public repo: `docs/measure/YYYY-MM-DD-<slug>.md`. A repo that is not
   public: that project's git-ignored work directory.

Do not run the harness without an explicit yes to the model, whichever caps apply (tokens, budget or both) and their approximate totals.

Both arms run headless with `--permission-mode acceptEdits`, a fixed allowed-tools list (override with `--allowed-tools "<space-separated>"`; read-only `gh`, no push) and a clone whose push URL is disabled. Only the disabled push URL is enforced; every other "no writes" rule is the allowed-tools list by convention (`node` and `npm` can run anything). Headless, a PreToolUse `ask` becomes a deny: the plugin's scope and approval asks refuse the edit instead of asking (probed on Claude Code 2.1.314). An arm that runs longer than `--timeout-min` (default 30) is killed and marked.

## Run

1. Write the prompt to a file with Write (a temp file, not in a clone).
2. Run, in one call, with a long Bash timeout (each arm can take 15 minutes):
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/measure/run.mjs" --repo <repo> --ref <sha> --prompt-file <file> --model <model> --max-tokens <n> | --budget <usd> --out <report.md> --gate "<cmd>" [--setup "<cmd>"] [--local-config <file>]`
   (`--max-tokens`, `--budget` or both; at least one)
3. Exit `1` with a FAILED report means `claude` could not be started, or an arm's `claude`
   exited non-zero with no result line, or `--setup` failed (the reason is on top of the report); exit `2` means a missing flag or cap: fix the arguments and ask before running again.
   Any other failure: report it and stop. Never re-run on your own; a re-run costs the
   same money again.

## After

The run prints `WARNING:` lines when the report or a stream contains the home directory, the temp directory, the plugin's real path or a forbidden term. Show every such line to the owner before anything is committed or published; the raw `.jsonl` streams are never committed (`docs/measure/*.jsonl` is git-ignored).

Read the report and show the owner the table. State only what it says, including `n=1 per arm; not a benchmark.` The raw streams sit next to it as `<report>.with.jsonl` and
`<report>.without.jsonl`. Do not commit or publish anything unless asked.
