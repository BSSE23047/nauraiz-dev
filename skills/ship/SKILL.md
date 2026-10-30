---
name: ship
description: "Push the task branch and open its pull request: rebase on a moved base, re-run the gate, settle approval lines, commit the plan, write the PR body in the repo's own format, push, gh pr create. Run only when the owner asks. Not for merging, force-pushing or reviewing a PR."
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" *) Bash(git fetch *) Bash(git rev-list *) Bash(git rev-parse *) Bash(git ls-remote *) Bash(git ls-tree *) Bash(git log *) Bash(git status *) Bash(git branch --show-current) Bash(gh pr list *) Bash(gh pr view *) Bash(gh issue view *) Read Write Edit Glob Grep
---

# ship

Push the current branch and open its PR. Only on the owner's request in this session to
push or open a PR; running `/nauraiz-dev:ship` is that request, so do not ask again
whether to push or open the PR. Do the steps in order.

Config: `.claude/nauraiz-dev.json`, with `.claude/nauraiz-dev.local.json` over it. Keys:
`branch.base` (default `main`), `plan.dir` (default `.work/tasks`), `pr.sections`, `gate`.
Local mode: the local file exists and the project file does not.

Rules for every step:

- "Stop" and "ask" mean: end your turn with the question and wait. Ask only what this
  skill cannot know.
- Never `--force` or `--force-with-lease`, never push to `<base>`, never merge, never
  enable auto-merge.
- Never write that the owner approved anything they did not say in this session.

## Steps

1. **Collision check.** `git branch --show-current` is `<branch>`; if it is `<base>`,
   stop. Issue: from the plan or the branch name (`feature/12-x` is 12). Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs" <issue> --branch <branch>`.
   `taken`: stop; say who and where (`reason`, `remoteBranch` name and authors, open PRs).
   `unknown` or no verdict: ask whether to go on, quoting `reason`. `ours` or `free`: go on.
   No issue: if `git ls-remote --heads origin <branch>` lists it and
   `git log HEAD..origin/<branch>` shows commits, stop: that work is not on this branch.

2. **Base.** `git fetch origin`, then `git rev-list --count HEAD..origin/<base>`. If 0, go on.
   Otherwise read `git log --oneline origin/<base>..HEAD`:
   - Branch already on origin: rebasing would need a force push. Stop; say how far behind
     it is and ask: merge `origin/<base>` into it, or ship as it is.
   - Commits that are not this task's (another issue, another author): stop, list them,
     ask which to keep.
   - Otherwise `git rebase origin/<base>`. On a conflict run `git rebase --abort`, stop and
     name the conflicting files.

3. **Gate.** Plan: the file under `plan.dir` whose `branch:` is `<branch>`. Run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" --plan <plan>` (no plan: drop `--plan`).
   Exit 1: stop and paste the output. Exit 2: ask "No gate configured. Ship without one?".
   Keep the output for step 6.

4. **Approvals.** Find every `*_approval` key in the plan whose value does not start with
   `pending`. None: go on. Otherwise one `AskUserQuestion` call, one question per value
   (more than four: one question for all), quoting the key and value, options
   "Keep as given" and "Set to pending". Headless (the run is unattended, or
   `AskUserQuestion` is unavailable, errors or returns no answer):
   set every one to `pending owner confirmation`. Never choose for the owner.

5. **Plan commit.** The project commits plans when
   `git ls-tree -r --name-only origin/<base> -- <plan.dir>` lists a file. If it does, and
   this is not local mode, commit the plan (and any step-4 change) as the last commit:
   `docs: plan for #<issue>`. In local mode never commit it.

6. **PR body.** Section headings, first match wins:
   `gh pr list --state merged --author @me --limit 1 --json number`, then
   `gh pr view <n> --json body`, and take that body's `## ` headings in order; else
   `pr.sections`. For each section's content run
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" templates/PR_TEMPLATE.md`.
   - Fill every section from the plan, the commits and this session; write "None"
     rather than drop one. Approvals set to pending go under the decisions to confirm.
   - The gate output from step 3, verbatim, under the gate heading (or `## Gate output`).
   - What was not verified, under the heading for it (such as `Unverified`), else add
     `## Not verified`.
   - `Closes #<issue>` when there is an issue. End with the PR attribution line your
     instructions give, if any.
   Write it to the path `git rev-parse --git-path nauraiz-dev-pr-body.md` prints, never
   into the working tree.

7. **Push and open.** `git push -u origin <branch>`; if it is rejected, stop and say why.
   Then `gh pr create --base <base> --head <branch> --title "<title>" --body-file <file>`,
   title from the issue or the plan. Print the PR URL and stop: never merge.
