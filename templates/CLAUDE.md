# {{projectName}} — instructions for Claude

Claude Code reads this file at the start of every session in this repo. Keep it under 200
lines; put detail in `.claude/knowledge/` and link to it from here.

## What this is

{{description}}

Stack: {{stack}}. Base branch: `{{baseBranch}}`.

## Where things are

{{layout}}
- `.claude/nauraiz-dev.json` — nauraiz-dev settings: enforcement level, gate, protected
  paths, model per task size. Machine-specific paths go in `.claude/nauraiz-dev.local.json`,
  which is git-ignored.
{{#scaffold}}
- `.claude/knowledge/` — how this codebase works, one topic per file, indexed in its
  `README.md`. Read the relevant file before working in an area.
- `.claude/rules/` — binding guardrails, one per file, each with the incident behind it.
- `.claude/skills/` — step-by-step procedures for tasks that recur in this repo (created
  when the first one is written).
- `.claude/state/` — `session.md` (now), `backlog.md` (still to do), `completed.md` (done).
- `docs/superpowers/plans/` — one plan per task branch (see "Plans" below).
{{/scaffold}}
{{#none}}
- `{{planDir}}/` — one plan per task branch (see "Plans" below). This project keeps no
  state files: the plan is the record of where a task stands.
- `.claude/knowledge/` and `.claude/rules/`, if present — how the codebase works, and
  binding guardrails with the incident behind each.
{{/none}}

## Commands and gate

{{gate}}

The gate is every command above. Before calling work done or opening a PR, run each one
and read its real exit code and summary line: a summary piped through `grep` or `tail` can
exit 0 while tests fail. Never call a command green that you did not run.

Protected paths: {{protectedPaths}}.

Enforcement level: `{{enforcement}}`.
- `advisory`: session-start context and a cost line only; never blocks or asks.
- `guided`: blocks every edit to a protected path; asks before an edit outside the
  plan's `### Allowed` list; warns once when a turn ends with edits made since the last
  gate run (when a gate is configured) or, with state files, since `session.md` was
  last updated.
- `strict`: as `guided`, but blocks the end of that turn instead of warning, and blocks
  a manual `/compact` while `session.md` is stale.

Set `scopeAsk` to `false` in the config to turn off the ask outside `### Allowed`;
init does so when the repo already has its own PreToolUse edit hook.

## Plans

A plan is a Markdown file whose frontmatter has `branch:` matching the task branch. Its
`### Allowed` list names the files the task may touch. In `guided` and `strict`,
editing anything else asks first (unless `scopeAsk` is `false`), so change the plan
before widening the scope. Its `## Handoff` section says where the work stands, for
whoever picks the task up next.

## Session discipline

{{#scaffold}}
1. **Start.** Read `.claude/state/session.md`, `.claude/state/backlog.md` and the
   `.claude/knowledge/` files for the area you will touch. Then rewrite `session.md`: the
   goal, the plan, and which knowledge and skill files you are using.
2. **During.** Write anything non-obvious you learn into `knowledge/` while it is fresh.
   Follow every file in `rules/`. If a file in `skills/` covers the task, follow it; if the
   task will clearly come up again, write one.
3. **End** (if real work was done). Move finished items from `backlog.md` to
   `completed.md` under an absolute date (`## 2026-01-31 — Title`, never "yesterday"),
   add any new work you found to `backlog.md`, and bring `session.md` up to date.
{{/scaffold}}
{{#none}}
1. **Start.** Find the plan in `{{planDir}}/` whose `branch:` is the current branch and
   read its `## Handoff`, then the `.claude/knowledge/` files for the area you will touch.
   No plan yet: write one (goal, `### Allowed`, `## Handoff`) before editing.
2. **During.** Write anything non-obvious you learn into `.claude/knowledge/` while it is
   fresh. Follow every file in `.claude/rules/`. Stay inside `### Allowed`.
3. **End** (if real work was done). Rewrite the plan's `## Handoff`: what is done, what is
   next, open questions, the files in play, with absolute dates (`2026-01-31`, never
   "yesterday"). Work you found that belongs to another task goes in the handoff as a
   follow-up, not into a new file.
{{/none}}

## Rules

Binding. Each rule is a file in `.claude/rules/` and is listed here.

{{rules}}
