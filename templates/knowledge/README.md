# Knowledge index

How this codebase works, written for the next session so it does not have to work it out
again.

One topic per file: the architecture, the data layer, a protocol, a convention, a
recurring "how do I…". List each file below with one line saying what it covers.

Write verified facts, each with the date you checked it (`Verified 2026-01-31:`), not
session history. Record what is true about the code, not what you did today; that goes
in `state/completed.md` or the plan's handoff. When a fact stops being true, fix the file
instead of appending a correction.

## Writing a rule (`.claude/rules/`)

Rules are binding guardrails: things that must not be done, or must always be done. One
rule per file, kept short. Every rule names the incident that caused it (the date, what
happened, what it cost), so whoever reads it later can judge an edge case instead of
guessing why the rule exists. A rule with no incident behind it is a preference; put it
here in `knowledge/` instead.

Claude Code loads every file in `.claude/rules/` each session (a rule with `paths:`
frontmatter only when matching files are in play), and nauraiz-dev passes them to every
subagent. A rule over about 1,500 characters reaches subagents as its heading and first
paragraph only, so state the constraint itself in that first paragraph. List every rule
in the "Rules" section of `CLAUDE.md`.

A rule file looks like this:

    # Never force-push a shared branch

    Rewrite history only on a branch nobody else has pulled. To undo a pushed commit
    on `main` or a release branch, push a revert.

    Incident, 2026-01-31: a force-push to `main` dropped two merged commits. They were
    recovered from a teammate's clone the next morning.

## Files

None yet.
