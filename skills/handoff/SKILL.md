---
name: handoff
description: "Write or refresh the session handoff before stopping, compacting or switching machines: goal, done, next, open questions, files in play. Use when asked to hand off, wrap up, or when the PreCompact/Stop reminder appears. Not a commit or PR step."
allowed-tools: Read Write Edit Glob Bash(git branch --show-current) Bash(git status --short) Bash(git log --oneline -10)
---

# handoff

Leave the next session (or the next machine) a record it can start from. The shape of
`session.md` and one filled example are in `reference.md` next to this file.

Rules for every step:

- Facts come from `git status --short`, `git log --oneline -10` and this conversation.
  Never invent a "done" item: list only what a commit, a changed file or the
  conversation shows.
- Write absolute dates (`2026-10-30`), never "today" or "yesterday". Today's date is in
  your context; if it is not, ask.
- Keep it short. The next session reads the first 20 lines of `session.md`, so put the
  goal, done and next first.

## Steps

1. Run `git branch --show-current`, `git status --short` and `git log --oneline -10`.
   Read `.claude/nauraiz-dev.json` for `state` and `plan.dir`; if there is a
   `.claude/nauraiz-dev.local.json`, it overrides. Then read the existing handoff file
   (step 4 says which one), and for `scaffold` also `.claude/state/backlog.md` and
   `.claude/state/completed.md`, before writing anything.

2. Draft the five parts from the facts: goal, done, next (the very next step first),
   open questions, files in play (paths from `git status`, plus files the conversation
   centred on). Carry over anything still true from the existing handoff; drop what is
   stale.

3. `scaffold` only, for backlog and completed (do this before step 4):
   - A `backlog.md` item is finished only if the conversation or a commit shows it. Move
     it to the top of `completed.md` as `## YYYY-MM-DD — Title`, a one-line summary, and
     the files or commit hashes touched (the format in the file's own header). Remove
     it from `backlog.md`.
   - Unsure whether an item is finished: ask the user. Do not move it on a guess.
   - Work that surfaced and is not started goes into `backlog.md` as a `## Title` heading
     with one line of context.

4. Write the handoff last, by `state`, so it is the newest file written:
   - `scaffold`: rewrite `.claude/state/session.md` in full with the five headings from
     `reference.md`. Rewriting the file also refreshes its mtime, which is what the
     PreCompact and Stop reminders compare against the last edit.
   - `none`: find the plan: the `.md` file under `plan.dir` (default `.work/tasks`)
     whose frontmatter `branch:` equals the current branch. Rewrite only its
     `## Handoff` section, leaving `## Scope`, `### Allowed` and every other section
     untouched. Start the section with the absolute date and a colon, as the plan
     template does.
   - `none` and no plan matches the branch, or no config file: write
     `.work/handoff.md` with the five parts, and say you did.

5. Print what you wrote and where, and the one line "Next: ...". Do not commit, push or
   open a PR; that is a separate step the user asks for.
