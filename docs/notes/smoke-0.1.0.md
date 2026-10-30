# Smoke run, 0.1.0

Date: 2026-10-30. Claude Code 2.1.314 on Windows 11, Node 24, model claude-opus-5-5.
The plugin was loaded straight from the working tree with `--plugin-dir`; it was not installed
through a marketplace (that check waits for the first release). superpowers was installed and
enabled on this machine, so the `dependencies` entry in `plugin.json` was satisfied and no
temporary copy was needed. Paths under the home directory are shown as `<home>`.

## Summary

| # | Check | Result |
| - | ----- | ------ |
| 1a | Empty git repo: SessionStart header appears, under 6000 chars | pass |
| 1b | Empty git repo: editing `.env` is not denied (no config, advisory) | pass |
| 2a | Configured repo: editing `.env` is denied with our reason | pass |
| 2b | Configured repo: Stop cost line is emitted | pass, seen in `stream-json` hook events, not in plain `-p` text |

## 1. Empty repo (no `.claude/nauraiz-dev.json`)

Setup: a temp directory, `git init`, one file `.env` containing `SECRET=1`.

### 1a. Header

    claude --plugin-dir "<repo>" --dangerously-skip-permissions -p \
      "Quote verbatim, in a code block, any context that the nauraiz-dev plugin injected into this session (the SessionStart hook output). If there is none, say 'none'."

Claude's reply quoted:

    nauraiz-dev v0.1.0 · enforcement=advisory · state=none · no project config: run /nauraiz-dev:init (project) or /nauraiz-dev:setup (machine)
    Triage the first substantive request: small → do it and verify; normal/large → plan before any edit.

Size, measured by piping a SessionStart payload for the same directory into
`scripts/hooks/session-start.mjs`: 240 characters, against the cap of 6000. The model also
mentioned a separate superpowers block in the session; it correctly did not attribute that to
nauraiz-dev. Pass.

### 1b. `.env` edit

    claude --plugin-dir "<repo>" --permission-mode acceptEdits -p \
      "Use the Edit tool to change the line in .env from SECRET=1 to SECRET=2. Then reply with exactly the tool result or any error you got."

Reply:

    The file <home>\AppData\Local\Temp\nd-smoke1-iSEg\.env has been updated successfully.

`.env` afterwards contained `SECRET=2`. No deny, as expected without a config. Pass.

## 2. Configured repo

Setup: `tests/fixtures/repos/configured` copied to a temp directory, `git init`, plus a `.env`
containing `SECRET=1`. The fixture config is
`{"enforcement":"guided","protectedPaths":[".env*","**/Generated*/**"]}` and a
`nauraiz-dev.local.json` with a `mockupRoot`.

### 2a. `.env` edit denied

Same prompt and flags as 1b. Reply:

    PreToolUse:Edit hook error: nauraiz-dev: .env is protected (.env*)

`.env` afterwards still contained `SECRET=1`. Pass.

### 2b. Stop cost line

Plain `-p` text output did not show the Stop hook's `systemMessage`; the 2a reply above carries
only the model's answer. To see it, the same directory was run with
`--output-format stream-json --verbose --include-hook-events -p "Reply with the single word ok."`.
Relevant events, trimmed:

    SessionStart:startup  additionalContext: "nauraiz-dev v0.1.0 · enforcement=guided · state=none\nTriage the first substantive request: ...\nMockup root: C:/mockups"
    Stop                  output: {"systemMessage":"nauraiz-dev · tokens in/out/cache: 2/4/30828"}
    informational         content: "Stop says: nauraiz-dev · tokens in/out/cache: 2/4/30828"

The SessionStart context in this repo was 177 characters. The cost line is emitted and Claude
Code surfaces it as a notice; whether an interactive session renders it the same way was not
observed here. Pass for emission, unobserved for interactive rendering.

## Not done

- Marketplace install (`/plugin marketplace add`, `/plugin install`): waits for the first release.
- Interactive session rendering of the Stop notice and of the PreToolUse deny.
- Behaviour with superpowers loaded, beyond the single observation in 1a that both sessions'
  context coexisted.
