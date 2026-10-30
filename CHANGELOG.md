# Changelog

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
