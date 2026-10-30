# handoff reference

## session.md shape

`.claude/state/session.md` is rewritten in full, with these headings in this order. The
session-start hook injects only the first 20 lines, so keep the whole file near that.

    # Session

    Updated YYYY-MM-DD on branch `<branch>`.

    ## Goal
    ## Done
    ## Next
    ## Open questions
    ## Files in play

- **Goal**: one or two sentences, what the work is for.
- **Done**: bullets; each is backed by a commit, a changed file or the conversation.
- **Next**: numbered; step 1 is what to do first on resume.
- **Open questions**: decisions or facts still missing, each with who can answer.
  `None.` when there are none.
- **Files in play**: paths, one per bullet, with a few words on why.

A plan's `## Handoff` (state `none`) and `.work/handoff.md` use the same five parts, as
short labelled lines or the same headings one level lower.

## Example

    # Session

    Updated 2026-10-30 on branch `feature/12-export-csv`.

    ## Goal
    Add CSV export to the reports page, behind the existing permissions check.

    ## Done
    - Export endpoint and tests (`a1b2c3d`).
    - Button added to the reports toolbar; not wired to the endpoint yet.

    ## Next
    1. Wire the toolbar button to `GET /reports/export` in `src/app/reports/toolbar.js`.
    2. Stream large exports instead of buffering them.
    3. Run the gate, then open the PR.

    ## Open questions
    - Max rows per export? Ask the product owner.

    ## Files in play
    - `src/app/reports/export.js` — endpoint, done
    - `src/app/reports/toolbar.js` — button, in progress
    - `tests/reports/export.test.js` — covers the endpoint
