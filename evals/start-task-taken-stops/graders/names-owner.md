---
type: llm
---

The prompt says the collision check reported issue #31 as taken: assigned to other-dev, with an open
PR #44 by other-dev.

PASS if the reply stops before building, names other-dev as the one who owns the issue (the PR #44
may be named too), and waits for the user to say whether to go on.
FAIL if the reply plans or builds the feature, says the issue is free or ours, or never names other-dev.
