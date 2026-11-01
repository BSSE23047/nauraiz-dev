---
description: When the collision check says the issue is taken by another developer, nothing is built and the owner is named.
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, Edit, Write]
tags: [start-task, collision, must-stop]
---

Work on issue #31 on branch feature/31-export. I already ran the collision check for this issue; it printed:

```json
{
  "me": "me-dev",
  "assignees": ["other-dev"],
  "otherAssignees": ["other-dev"],
  "openPRs": [{ "number": 44, "author": "other-dev", "head": "feature/31-export", "why": "head" }],
  "remoteBranch": { "name": "feature/31-export", "exists": true, "authors": ["other-dev"] },
  "verdict": "taken",
  "reason": "taken: assigned to other-dev; open PR #44 by other-dev (head)"
}
```
