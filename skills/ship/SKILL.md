---
name: ship
description: "Push the task branch and open its pull request: rebase on a moved base, settle approval lines, commit the plan, re-run the gate, write the PR body in the repo's own format, push, gh pr create. Run only when the owner asks. Not for merging, force-pushing or reviewing a PR."
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" *) Bash(git fetch *) Bash(git rev-list *) Bash(git rev-parse *) Bash(git ls-remote *) Bash(git ls-tree *) Bash(git ls-files *) Bash(git log *) Bash(git status *) Bash(git config user.name) Bash(git config user.email) Bash(git branch --show-current) Bash(gh pr list *) Bash(gh pr view *) Bash(gh issue view *) Read Write Edit Glob Grep
---

# ship

Push the current branch and open its PR. Only on the owner's request in this session to
push or open a PR; running `/nauraiz-dev:ship` is that request, so do not ask again
whether to push or open the PR. Do the steps in order.

Config: `.claude/nauraiz-dev.json`, with `.claude/nauraiz-dev.local.json` over it. Keys:
`branch.base` (default `main`), `plan.dir` (default `.work/tasks`), `pr.sections`, `gate`.
Local mode: the local file exists and the project file does not. Plan: the file under
`plan.dir` whose `branch:` is this branch.

Rules for every step:

- "Stop" and "ask" mean: end your turn with the question and wait. Ask only what this
  skill cannot know.
- Never `--force` or `--force-with-lease`, never rewrite history beyond step 2's rebase,
  never push to `<base>`, never merge, never enable auto-merge.
- Never write that the owner approved anything they did not say in this session.

## Steps

1. **Collision check.** `git branch --show-current` is `<branch>`; if it is `<base>`,
   stop. Run `git fetch origin`. Issue: from the plan or the branch name (`feature/12-x`
   is 12). Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/task/collision.mjs" <issue> --branch <branch>`.
   `taken`: stop; say who and where (`reason`, `remoteBranch` name and authors, open PRs).
   `unknown` or no verdict: ask whether to go on, quoting `reason`. `ours` or `free`: go on.
   No issue, and `git ls-remote --heads origin <branch>` lists the branch: read
   `git log --format='%an <%ae>' origin/<base>..origin/<branch>`. If any author matches
   neither `git config user.name` nor `git config user.email`, stop and name them.

2. **Base.** If `git status --porcelain --untracked-files=no`, leaving out the plan file
   (step 4 commits it), prints anything, stop and ask the owner to commit or stash it:
   the gate runs on the working tree, but the push sends HEAD. Then `git rev-list --count HEAD..origin/<base>`. If 0, go on. Otherwise
   read `git log --oneline origin/<base>..HEAD`:
   - Branch already on origin: rebasing would need a force push. Stop; say how far behind
     it is and ask: merge `origin/<base>` into it, or ship as it is.
   - Commits that are not this task's (another issue, another author): stop and list them.
   - Otherwise `git rebase origin/<base>`.
   - On a conflict: `git rebase --abort`, stop, name the conflicting files.
   - If the rebase refuses to start (not a conflict): stop and quote its message.

3. **Approvals.** Find every `*_approval` key in the plan whose value does not start with
   `pending`. None: go on. Otherwise one `AskUserQuestion` call, one question per value
   (more than four: one question for all), quoting the key and value, options
   "Keep as given" and "Set to pending". Headless (the run is unattended, or
   `AskUserQuestion` is unavailable, errors or returns no answer):
   set every one to `pending owner confirmation`. Never choose for the owner.

4. **Plan commit.** Commit the plan as its own commit (`docs: plan for #<issue>`; no
   issue: `docs: plan for <branch>`) when `git status --porcelain -- <plan>` shows a change
   and it is tracked (`git ls-files <plan>` prints it) or the project commits plans
   (`git ls-tree -r --name-only origin/<base> -- <plan.dir>` lists a file). Never commit an
   untracked plan in local mode. Committing before the gate makes the pushed HEAD the
   gated HEAD with no rewrite. That covers tracked files only:
   an untracked file the gate reads is not pushed; tell the owner to add it or ignore it.

5. **Gate.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate/run.mjs" --plan <plan>` (no plan:
   drop `--plan`). Exit 1: stop and paste the output. Exit 2: quote every `nauraiz-dev:`
   line first. A line other than `no gate configured …` that names a config file means
   the config failed to load: stop, say it needs fixing, and never offer to ship without a gate.
   Otherwise ask "No gate configured. Ship without one?". Any other non-zero exit: stop
   and quote the output. Keep the output for step 6.

6. **PR body.** If `gh pr view <branch> --json url,state` shows an `OPEN` PR, skip this
   step. Headings, first match wins:
   `gh pr list --state merged --author @me --limit 1 --json number`, then
   `gh pr view <n> --json body`, and take that body's `## ` headings in order; else
   `pr.sections`. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" templates/PR_TEMPLATE.md`
   once for what each section holds.
   - Fill every section from the plan, the commits and this session; write "None"
     rather than drop one. Approvals set to pending go under the decisions to confirm.
   - The gate output from step 5, verbatim, under the gate heading (or `## Gate output`).
   - What was not verified, under the heading for it (such as `Unverified`), else add
     `## Not verified`.
   - `Closes #<issue>` when there is an issue. End with the PR attribution line your
     instructions give, if any.
   Write it to the path `git rev-parse --git-path nauraiz-dev-pr-body.md` prints, never
   into the working tree.

7. **Push and open.** `git push -u origin <branch>`; if it is rejected, stop and say why.
   An open PR from step 6: print its URL instead of `gh pr create`. Otherwise
   `gh pr create --base <base> --head <branch> --title "<title>" --body-file <file>`,
   title from the issue or the plan. Print the PR URL and stop: never merge.
