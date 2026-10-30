---
name: memory-hygiene
description: "Clean up project memory: 'clean up my memory', 'prune the knowledge files', MEMORY.md too long. Finds stale or relative-dated entries, dead file references. Not for adding a lesson (capture-lesson)."
allowed-tools: Read Edit Glob Grep Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/memory/scan.mjs" *)
---

# memory-hygiene

Memory rots: "yesterday" means nothing a week later, files get renamed, facts stop being
true. This finds the rot and proposes fixes; the owner approves each one.

"Stop" and "ask" mean: end your turn with the question and wait.

1. **Find the folders.** The project's `.claude/knowledge` and `.claude/rules` (those
   that exist), and the auto-memory folder: Glob `*/memory/MEMORY.md` in
   `<home>/.claude/projects` and take the folder named like the current directory with
   `:`, `\`, `/` and spaces each replaced by `-`. No match: scan without it and say so.

2. **Scan.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/memory/scan.mjs" <dir>...` with
   those folders (quote paths; add `--today <date>` only if asked). It prints JSON: per
   file `lines`, `bytes`, `relativeDates`, `staleSince`, `missingRefs`, `brokenLinks`,
   and `index` for `MEMORY.md` (`overLimit` above 200 lines or 25,000 bytes).

3. **Check what the script cannot.** Read the files it flagged, plus the index. Look for
   two entries that contradict each other, a fact the code now disproves (Grep to
   check), and entries that duplicate each other. Do not Read files nothing flagged.

4. **Propose, do not edit.** Show one diff-style list, grouped by file:
   - `relativeDates`: rewrite to the absolute date the entry was written (from the
     file's own dates or `git log`); if unknown, ask.
   - `staleSince`: confirm, update or delete. Say the date and the age.
   - `missingRefs` and `brokenLinks`: fix the path, drop the reference, or delete the
     entry if it was only about the missing file. A flag on an ordinary word such as
     `Next.js` is a false alarm: skip it.
   - Contradictions and duplicates: say which entry wins and why.
   - `index.overLimit`: name the entries to merge or drop to get under the limits.
   Then **stop** and ask which to apply.

5. **Apply only the approved ones** with Edit. Never delete a file unless the owner
   said to. Keep `MEMORY.md` and `knowledge/README.md` in step with every file you
   rename or remove. Run the scan again and report the counts before and after.

6. If the `/doctor` command is available in this Claude Code version, mention it: it
   audits the prompt files this skill does not cover. Do not run it for the owner.
