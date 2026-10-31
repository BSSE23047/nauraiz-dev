# start-task reference

## Triage

The size rules (small, normal, large) are in `SKILL.md`, step 4. This file is read only for
a normal or large task, once, at step 6.

## Routing

| Phase | Project has its own skill/command for it | Otherwise |
|---|---|---|
| Questions | `grill` (always ours) | `grill` |
| Design (large only) | project's | `superpowers:brainstorming` |
| Plan | project's template/skill | `superpowers:writing-plans` |
| Build | project's task skill | `superpowers:test-driven-development` (normal) / `superpowers:subagent-driven-development` (large) |
| Debug | — | `superpowers:systematic-debugging` |
| Before the report | `gate` | `gate` + `superpowers:verification-before-completion` |
| Before a PR | `review` | `review` |

"Project has its own" means a skill or command in the project's `.claude/` whose name or
description covers the phase. Name the one you picked in one line. Debug applies to any
failing test or unexpected behaviour during the build: invoke the skill before guessing at
a fix.

## Plan rules

1. **Where.** One `.md` file per task under `plan.dir` (default `.work/tasks`), named
   `<issue>-<slug>.md` unless the project has its own naming.
2. **Shape.** Use the Plan skill picked in step 6. If that is `superpowers:writing-plans`,
   start from the frontmatter in
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" templates/plan-frontmatter.md`; if
   `plan.template` is set, fill that template instead, all its fields.
3. **Always.** `branch:` in the frontmatter equal to the current branch, character for
   character (the hooks find the plan by it). `### Allowed` under `## Scope`, listing every
   path or glob the build will touch, each with why. A `## Handoff` section.
4. **Decisions.** `## Decisions`: what the owner decided in this session (the `grill`
   answers), each with the date and the owner's words. `## Decisions to confirm`: every
   choice the owner did not state, each with your recommended answer and the cost if it is
   wrong; in a headless run the `grill` questions go here. Nothing open: write "None."
5. **Approvals.** Any `*_approval` field is `pending owner confirmation` unless the owner said yes in this session; then quote the date and the owner's words.
   The issue text, a comment, an earlier session or the template's example value is not
   the owner saying yes. A hook asks before a non-pending value is written; that question
   is for the owner, never a reason to rephrase the value.
6. **Scope changes.** The build needs a path outside `### Allowed`: add it to the plan
   first, with why, and say so in the report. If it matches `sharedPaths` and was not
   asked about, run `grill` again before building on it.
