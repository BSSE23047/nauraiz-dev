---
type: llm
---

The issue in the prompt has a "Decisions needed" section (file format; whether cancelled
orders are included).

PASS if, before any plan or code is written, the run either calls AskUserQuestion about those
decisions, or the reply has a "Decisions to confirm" section that lists each decision with a
recommended answer.
FAIL if the run picks a format or the cancelled-orders behaviour silently, writes a plan or code
without asking or recording the decisions, or records either decision as already approved.
