---
name: capture-lesson
description: "Save a gotcha just hit (hang, timeout, blocked command, wrong path) as a dated lesson: 'remember that for next time'. Not for session notes (handoff), task lists, or things the code shows."
allowed-tools: Read Write Edit Glob Grep
---

# capture-lesson

Turn something that just cost time into a dated entry the next session reads, so it is
not paid for twice. One lesson per file, facts only.

"Stop" and "ask" mean: end your turn with the question and wait.

1. **Pin the lesson.** Get four facts from the session or the owner: what happened, what
   fixed it, how to recognise it next time, what it cost. Missing one: ask. Write nothing
   you did not see or were not told. Use absolute dates (`2026-10-31`), never "today" or
   "last week".

2. **Pick the place.**
   - `local` mode (the session header shows `mode=local`, or `.claude/nauraiz-dev.local.json`
     exists and `.claude/nauraiz-dev.json` does not): **auto-memory only**. Never write a
     tracked file.
   - Machine-specific (a path, a tool version, a login on this computer): auto-memory.
   - A rule (something that must never or always be done, with an incident behind it) and
     `.claude/rules/` exists: a rule file.
   - Else, if `.claude/knowledge/` exists: a knowledge file.
   - Else: auto-memory.

   Auto-memory folder: `~/.claude/projects/<slug>/memory/` under the user's home, where
   `<slug>` is the current directory with `:`, `\`, `/` and spaces each replaced by `-`.
   Find it with Glob on `*/memory/MEMORY.md` in `<home>/.claude/projects`, take the folder
   whose name equals the slug. No match: ask the owner for the folder and stop.

3. **Look for an existing entry.** Grep the folder for the topic. Found: fix that file
   (replace the wrong fact, do not append a correction). Not found: one new file named
   after the topic, e.g. `windows-spawn-needs-shell.md`.

4. **Write it.**
   - Knowledge file: a heading, then `Verified <date>:` facts, then the incident in one
     sentence (date, what happened, what it cost).
   - Rule file: a heading, the constraint in the first paragraph, then
     `Incident, <date>: <what happened and what it cost>`. Add it to the "Rules" list in
     `CLAUDE.md`.
   - Auto-memory file: frontmatter `name`, `description` (one line), `metadata:` with
     `type:` (`feedback`, `project`, `reference` or `user`); then the body as above.
   - Related entries: link each with `[[file-name]]` (no `.md`), only to files that exist,
     and add the link back in the other file.

5. **Index it.** Knowledge: one line in `.claude/knowledge/README.md` under "Files"
   (replace `None yet.`). Auto-memory: one line in `MEMORY.md`,
   `- [Title](file.md) — one-line hook`, under 150 characters. If `MEMORY.md` has more
   than 200 lines, say so and suggest `/nauraiz-dev:memory-hygiene`.

6. **Report.** The file written or changed, the index line added, and the lesson in one
   sentence. Do not commit.
