# nauraiz-dev design

What this plugin is for, what it deliberately is not, and the decisions behind 0.1.0.

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
   memory is pruned, relevant skills are suggested with their context cost (later releases).
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

## Roadmap

- 0.2: `start-task` (triage small/normal/large), `grill` (one grounded question at a time),
  `kickoff-prompt` (issue to pasteable prompt), `gate` (read real exit codes and summaries),
  `review`, `capture-lesson`, and two agents (implementer, reviewer).
- 0.3: `memory-hygiene`, `find-skills`, `measure` (the same task with and without the
  plugin, reporting tokens, time and gate result), and the first published numbers.
