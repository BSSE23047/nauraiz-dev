---
name: grill
description: "Ask the owner the few questions that change what gets built, before the plan: open decisions, shared paths, required approvals. Use from start-task or when asked to clarify a task. Not for small fixes or what the repo already answers."
allowed-tools: Bash(gh issue view *) Read Glob Grep
---

# grill

Ask only questions the repo and the issue cannot answer **and** where a wrong guess changes
what gets built. Search first: the issue and its comments, the code (Grep, Glob), the
project's `.claude/` and its plan template (`plan.template` in `.claude/nauraiz-dev.json`,
with `.claude/nauraiz-dev.local.json` over it). Never ask what you could have looked up.

## Must ask, before the plan, when any of these holds

- The issue has a "Decisions needed" or "Open decision" section, or contains the words
  "decide", "confirm" or "TBD".
- The work touches a path that matches a `sharedPaths` pattern (gitignore syntax) in the
  config, or the plan template's `kind` field offers a value containing `shared` (such as
  `shared-seam`) and that is the kind this work is.
- The plan template has any `*_approval` field: the owner must give that approval.

Your own judgement may add a question; it never removes a must-ask. If nothing holds and
nothing material is open, say "No questions: <one-line reason>" and return.

## How to ask

- At most 3 questions per round, normally one round. Keep the ones with the highest cost
  if guessed wrong.
- Each question gives the options, your recommendation, and the cost if the recommendation
  is wrong (what would have to be redone).
- Ask with `AskUserQuestion`: one call, multiple choice, the recommended option first and
  labelled "(Recommended)". If it is unavailable, errors, or returns no answer, follow the
  headless rule below.
- An approval question asks for the approval itself. Record it only on a yes, with the date
  and the owner's words; otherwise it stays `pending owner confirmation`.
- The owner's answers are decisions: hold them until step 8 writes the plan (start-task),
  which puts them under `## Decisions` with the date and the owner's words. "Decisions to
  confirm" is only for choices the owner did not state.

## Headless: no human to answer

You are headless when the request says the run is unattended, headless or
non-interactive (for example `claude -p`), or `AskUserQuestion` is not available, errors
or returns no answer. Then do not ask and do not wait: write each question with its
recommended answer under "Decisions to confirm" in the plan (in the reply if there is no
plan yet), and proceed on the recommendation. A recommendation is never recorded as the
owner's decision or approval.

## After the round

- Play back in two to four lines what will be built, with the answers.
- Hand back to `start-task`: it runs the next phase it routed (the Design phase for large
  tasks, the plan for normal ones). Called on its own, stop after the play-back.
