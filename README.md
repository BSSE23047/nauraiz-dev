# nauraiz-dev

A Claude Code plugin for the way work gets done: triage, grounded questions, kickoff prompts, a gate that reads real results, and memory that survives the session. It layers on [superpowers](https://github.com/obra/superpowers). Version 0.1.0 is the foundation: five hooks and three skills. The workflow skills come later (see Roadmap).

## Install

```
/plugin marketplace add BSSE23047/nauraiz-dev
/plugin install nauraiz-dev@nauraiz-dev
```

Needs Node 20 or newer on the PATH and Claude Code. The plugin depends on `superpowers@claude-plugins-official`. If install reports a cross-marketplace dependency error, add `"allowCrossMarketplaceDependenciesOn": ["claude-plugins-official"]` to `~/.claude/settings.json` and install again.

Then run `/nauraiz-dev:setup` once per machine and `/nauraiz-dev:init` once per project.

## What you get in 0.1.0

### Hooks

All five are plain Node scripts with explicit timeouts. A hook never throws: on any error it exits 0 and stays silent.

| Event | What it does | Levels |
| --- | --- | --- |
| `SessionStart` | Injects a short header: version, enforcement level, a one-line triage rule, and the session state or current plan handoff if there is one. Capped at 6000 characters. Without a project config it says to run `init` or `setup`. A config that cannot be read is named in the header and shown to you as a system message. | all |
| `PreToolUse` (Write, Edit, MultiEdit, NotebookEdit) | Denies edits to protected paths (`.env*` is always protected once a config exists). Asks before editing a path outside the branch plan's `### Allowed` list, except the plan itself, `.claude/state/` and `.work/handoff.md`. | `guided`, `strict`. `advisory` never denies or asks. An unreadable project config still denies `.env*`. |
| `SubagentStart` | Injects the project's rules and the gate command names into subagents, which do not inherit `CLAUDE.md`. Silent without a project config. | all, once a config exists |
| `Stop` | Prints a one-line token count. If files were edited and a configured gate was not run afterwards (from any shell tool, Bash or PowerShell), or (with `state: scaffold`) `session.md` is older than the last edit, it warns once per problem (`guided`) or forces one more turn (`strict`). Edits to `.claude/state/`, `.work/handoff.md` and the plan directory do not count as edits. | cost line: all. Warn: `guided`. One more turn: `strict`. |
| `PreCompact` | Blocks a manual `/compact` until `session.md` is newer than the last edit (edits counted as for `Stop`). Does nothing otherwise. | `strict` with `state: scaffold` only |

### Skills

| Skill | Use it to | Invoked by |
| --- | --- | --- |
| `/nauraiz-dev:init` | Detect the stack and gate commands, write `.claude/nauraiz-dev.json`, a short `CLAUDE.md` and the memory scaffold. | you only |
| `/nauraiz-dev:setup` | Check the machine: Node, Claude Code, superpowers enabled, hooks registered once, auto-memory on. | you only |
| `/nauraiz-dev:handoff` | Write or refresh the session handoff: goal, done, next, open questions, files in play. | you, or Claude when you ask to wrap up |

## Configuration

Project settings live in `.claude/nauraiz-dev.json`, committed with the repo and written by `init`. Machine-specific values (for example a `mockupRoot` path) go in `.claude/nauraiz-dev.local.json`, which is git-ignored and merged over the project file. A starting point is [templates/nauraiz-dev.json](templates/nauraiz-dev.json).

| Key | Meaning | Default |
| --- | --- | --- |
| `enforcement` | `advisory`, `guided` or `strict` (below). | `guided` when a config exists without it |
| `state` | `scaffold` (three state files plus knowledge and rules) or `none` (plans in `plan.dir` carry the handoff). | `none` |
| `scopeAsk` | Ask before editing outside the plan's Allowed list. `init` sets it to `false` if you already have your own PreToolUse hook. | `true` |
| `gate` | Named commands that make up your gate, for example `{ "build": "npm run build" }`. | `{}` |
| `protectedPaths` | Globs the PreToolUse hook denies, with gitignore semantics: `dist/`, `/dist` and `dist` all cover `dist/a.js`. | `[]`, plus `.env*` |
| `models` | Model per kind of work: `small`, `normal`, `large`, `review`, `fix-round`. | sonnet, opus, opus, opus, sonnet |
| `branch` | `base`, `pattern`, `merge` for branch naming and merging. | `main`, `feature/${issue}-${slug}`, `merge` |
| `plan` | `dir` where plans live, and an optional `template`. | `.work/tasks`, none. With `state: scaffold` and no `plan.dir` set, `dir` is `docs/superpowers/plans`. |
| `mockupRoot` | Local folder of design mockups. Set it in `.local.json`; it is shown at session start. | unset |
| `pr` | Section headings for pull request descriptions. | Summary, Steps ↔ commits, Gate output, Decisions to confirm, Risks, Unverified |

In 0.1.0 the hooks read `enforcement`, `state`, `scopeAsk`, `gate`, `protectedPaths` and `plan.dir`. `models`, `branch`, `pr` and `plan.template` are stored for the skills in the next plans.

### Enforcement levels

- `advisory`: context and the cost line only. Nothing is denied, asked or blocked. This is also what a repo with no config gets.
- `guided`: the default `init` writes. Denies protected paths, asks outside the plan, warns once on a skipped gate or a stale handoff. The gate check needs a configured `gate`; the handoff check needs `state: scaffold`.
- `strict`: everything in `guided`, and when the gate has not run after the last edit or the handoff is stale, a `Stop` forces one more turn to run the gate / write the handoff (the stop after that goes through, so it cannot loop), and a manual `/compact` is blocked until the handoff is current. The gate check needs a configured `gate`; the handoff check needs `state: scaffold`.

## Known limits

- The protected-path deny covers the Write, Edit, MultiEdit and NotebookEdit tools. It does not see shell writes such as `echo > .env`.
- Path matching is case-insensitive on Windows only.
- Path patterns follow gitignore directory semantics: a pattern that matches a directory covers everything under it, and a pattern without a `/` matches a name at any depth.
- A project config that cannot be read shows a system message at session start; until it is fixed, only `.env*` stays protected, and nothing is asked or blocked otherwise.
- Config is read from the session's working directory. There is no search of parent directories.
- The evals ran without superpowers loaded, so how the skills trigger alongside superpowers is not yet measured. See [the eval summary](evals/results/2026-10-30-summary.md).
- The plugin icon is a placeholder.

A smoke run of the loaded plugin (header, deny, cost line) is recorded in [docs/notes/smoke-0.1.0.md](docs/notes/smoke-0.1.0.md).

## What this is not

- Not a fork or replacement of superpowers. It calls superpowers' skills and does not copy them.
- Not a memory runtime: no database, worker process or MCP server. Files only.
- Not a document-generation framework: no sprint docs, personas or ceremony files.
- Not a general agent pack.
- Not for other harnesses. Claude Code only.
- It never requires screenshots, browser comparisons or live-login steps. A project may add them to its own gate.

The design and its reasoning are in [docs/design.md](docs/design.md).

## Roadmap

- Plan 2: `start-task` (triage), `grill` (grounded questions), `kickoff-prompt`, `gate`.
- Plan 3: `review`, `capture-lesson`, `memory-hygiene`, `find-skills`, `measure`.

Dates are not promised.

## Licence

MIT. See [LICENSE](LICENSE).
