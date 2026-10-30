---
description: An issue with a "Decisions needed" section makes Claude ask (or record the questions) before planning.
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill, AskUserQuestion]
tags: [grill, must-ask]
---

Work on this task. There is no GitHub issue; the task is described here in full:

# Export the order list

Add an "Export" button to the orders page that downloads the visible orders.

## Decisions needed

- File format: CSV or JSON?
- Should the export include cancelled orders?

## Acceptance

- The button sits next to the page title.
- The download respects the current filters.
