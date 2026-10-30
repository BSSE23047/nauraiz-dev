---
name: review
description: "Review code before or in a PR: 'review my branch', 'check this before the PR', 'review PR #12'. Runs the reviewer agent on the diff and the gate; writes review notes, never an approval. Not for pushing or opening a PR (that is /nauraiz-dev:ship) or fixing findings."
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" *) Bash(git fetch *) Bash(git diff *) Bash(git rev-parse *) Bash(git status *) Bash(git branch --show-current) Bash(git worktree *) Bash(gh pr view *) Bash(gh pr diff *) Read Glob Grep
---

# review

Two modes. No argument, or the owner's own branch: **branch mode**. A PR number:
**PR mode**.

Config: `.claude/nauraiz-dev.json`, with `.claude/nauraiz-dev.local.json` over it. Keys:
`branch.base` (default `main`), `branch.merge` (default `merge`), `models.review`, `gate`.

Rules for both modes:

- "Stop" means: end your turn and wait.
- Never paste a diff into this thread. Write it to a file under
  `git rev-parse --git-path` and give the path to the reviewer; look at `--stat` only.
- These are review notes. Never write "Approved" or "LGTM", never submit an approving
  GitHub review.
- Never change the owner's checkout: no `git checkout`, `git switch`, `gh pr checkout`,
  `git stash`, no edits. Note `git branch --show-current` first; it must match at the end.
- Merge only when the owner says "merge" in this session.

Reviewer: the Agent tool with `subagent_type` `nauraiz-dev:reviewer`, `model` set to
`models.review` when configured. Its prompt: the diff file path, the base, the plan path
and issue if any, and for a PR its title and body. It returns findings by severity.

## Branch mode

1. `git fetch origin <base>`. If `git status --short` lists changes, say they are not
   in the review.
2. Diff file: `<diff>` is what `git rev-parse --git-path nauraiz-dev-review.diff` prints.
   Run `git diff origin/<base>...HEAD > "<diff>"`. Empty: say "Nothing to review against
   origin/<base>" and stop.
3. Dispatch the reviewer on `<diff>`. Meanwhile run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs"` (exit 2: say no gate is configured).
4. Report: the findings ranked by severity, the gate output verbatim, what was not
   checked. End with what to fix before `/nauraiz-dev:ship`, or "No blocking findings".
   Do not fix anything unless the owner asks. Stop.

## PR mode

1. `gh pr view <n> --json number,title,body,author,baseRefName,headRefName,closingIssuesReferences`.
2. `<diff>` from `git rev-parse --git-path nauraiz-dev-pr-<n>.diff`; run
   `gh pr diff <n> > "<diff>"`. Dispatch the reviewer on it.
3. Gate on the PR head, outside the owner's checkout:
   - `git fetch origin pull/<n>/head`, then
     `git worktree add --detach "<wt>" FETCH_HEAD`, where `<wt>` is
     `../<this folder's name>-review-<n>` (quoted: paths may have spaces).
   - Copy this checkout's `.claude/nauraiz-dev.json` and `.claude/nauraiz-dev.local.json`
     (those that exist) into `<wt>/.claude/`, so the PR cannot change which commands run.
     Install dependencies in `<wt>` if the gate needs them (`npm ci`, `flutter pub get`).
   - `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" --cwd "<wt>"`; add
     `--plan "<wt>/<plan>"` if the PR carries a plan for `headRefName`.
   - Then `git worktree remove --force "<wt>"` and `git worktree prune`,
     even when a step failed.
4. If the `/code-review` skill is available, run it on PR `<n>` (no `--comment`).
5. Review notes: the reviewer's and `/code-review`'s findings merged and ranked by
   severity, the gate output verbatim, what was not verified. Post them on the PR
   (`gh pr comment`) only if the owner asks. Stop.
6. Only after the owner says "merge": `gh pr merge <n> --<branch.merge>` (merge, squash
   or rebase), never `--admin`. After a merge only: close any of
   `closingIssuesReferences` still open (`gh issue close`), and offer the next kickoff
   prompt with the `kickoff-prompt` skill.
