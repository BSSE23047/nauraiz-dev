---
name: setup
description: "Check and fix the machine for nauraiz-dev: Node, Claude Code, superpowers installed and enabled, hooks registered once, auto-memory on; offer a user-level CLAUDE.md. Run on a new machine or when something looks off. Not a project setup (use init)."
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/check.mjs" *) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" *) Read Write
---

# setup

Check this machine for nauraiz-dev and offer the fixes. Get the user-level template with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/show.mjs" templates/user-CLAUDE.md`; never Read
plugin files directly.

Two limits apply to every step:

- Ask before running each fix and before writing `~/.claude/CLAUDE.md`. One question
  per fix; a no skips it and the rest carry on.
- Never edit `~/.claude/settings.json` yourself. Print the exact change and let the user
  make it.

## Steps

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup/check.mjs"` and read the JSON.

2. Show a table, one row per check, with `ok`, `missing` or `off`:
   Node (`node.version`, ok when `node.ok`), Claude Code (`claude.version`), superpowers
   (installed and enabled), nauraiz-dev (installed and enabled), hooks registered once
   (ok when `duplicateHooks` is empty), auto-memory (`autoMemory`), cross-marketplace
   dependencies (`crossMarketplace.allowed`), user `~/.claude/CLAUDE.md` (`userClaudeMd`).
   Recommend installing nauraiz-dev at user scope, `claude plugin install nauraiz-dev@nauraiz-dev --scope user`,
   because then every folder shows the nauraiz-dev header, not only repos that enable it.
   If `fixes` is empty and `userClaudeMd` is true, say the machine is ready and stop.

3. Go through `fixes` in order, one at a time:
   - A line that starts with `claude plugin` is a command: show it, ask, and on yes run
     it with Bash (Claude Code asks for permission on its own, since only the check
     script is pre-approved). If `claude.version` is null, say so before running anything.
     When the line installs nauraiz-dev, add `--scope user` to it.
   - Any other line is an instruction about a file (a hook to remove from
     `settings.json`, a setting to add). Print it as given, with the exact text to add or
     remove, and ask the user to make that change themselves. Do not edit the file.
   - The cross-marketplace line applies only if installing nauraiz-dev reports a
     dependency error; say that, and do not ask the user to do it otherwise.

4. If `userClaudeMd` is false, offer to create `~/.claude/CLAUDE.md` from the template.
   Ask the user for the commit identity, preferred models, review style and a line or two
   about themselves, fill every `{{...}}` from the answers (leave none), show the result,
   and write it only after a yes. Never overwrite an existing file. This file holds things
   about the user, not about a project.

5. Print what was run, what was skipped and what the user still has to do by hand. Finish
   with: restart Claude Code, so plugin and settings changes take effect.
