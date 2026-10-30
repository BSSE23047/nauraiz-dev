---
name: kickoff-prompt
description: "Write a kickoff prompt for an issue or task, for a fresh session here or elsewhere: guard block, branch, files, decisions, gate, stops, model, budget. Use when asked for a kickoff prompt. Not for doing the task."
allowed-tools: Bash(gh issue view *) Bash(git branch --show-current) Bash(git rev-parse --show-toplevel) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" *) Read Glob Grep
---

# kickoff-prompt

Write one prompt that a fresh session can run without this conversation. Do not start the
task. Get the shape with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" templates/kickoff-prompt.md` (never Read
plugin files directly), keep its guard block first, and fill every `{{…}}`; none may remain.

## Inputs

1. The issue: `gh issue view <n> --json title,body,assignees,labels,comments`. A sentence
   instead of an issue: that sentence is the spec. `gh` fails: say so and ask for the text.
2. Config: `.claude/nauraiz-dev.json`, with `.claude/nauraiz-dev.local.json` over it:
   `branch.base`, `branch.pattern`, `gate`, `models`, `protectedPaths`, `mockupRoot`.
3. `git rev-parse --show-toplevel` and `git branch --show-current`.

## Filling the template

- `{{absPath}}`: the absolute directory the run must work in, in the OS's own form: the
  repo root, or the worktree the owner named.
- `{{branch}}`: the branch the issue names, else `branch.pattern` with the issue number and
  a short slug. `{{base}}`: `branch.base`.
- `{{version}}`, `{{enforcement}}`: from this session's start line
  `nauraiz-dev v… · enforcement=…`. Not in your context: ask the owner.
- `{{title}}`, `{{issueRef}}`: the issue title and `#<n>` (or "no issue").
- Files to read: paths the issue names, plus the files that own the behaviour (find them
  with Grep; list paths, not contents). Files not to read: generated folders, lockfiles,
  `protectedPaths`, and what the issue puts out of scope.
- Mockups and specs: the files the issue names, under `mockupRoot` when it is set. Never
  invent a path; none known: "None."
- Decisions already made: only what the issue, its comments or the owner in this session
  decided, each with its source. Open questions go under "Decisions to confirm", each with
  a recommendation, for the run's `grill`.
- Gate: one line per `gate` entry (`name`: `command`); none configured: say so.
- Model: size the task small / normal / large as `start-task` does and name
  `models.<size>` and the size.
- Budget: the cap the owner gave (USD or time). None given: recommend one by size
  (small 1 USD, normal 4 USD, large 10 USD) and mark it "(recommended, owner to confirm)".
- `{{extraStops}}`: stop conditions the issue adds, one `- ` line each, or delete the line.
- The owner authorised a PR in this session: replace the first "Never" line with what they
  allowed. Otherwise keep it.

## Output

Print the prompt in one fenced block, ready to paste. Under it, one line naming the model
and the budget, and one line: "Before pasting: check out `<branch>` in `<absPath>`" (the
guard stops the run on any other branch or directory). Write no file unless asked.
