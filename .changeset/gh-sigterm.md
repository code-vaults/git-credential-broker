---
'gcb-host': patch
---

Terminate a timed-out `gh` action with `SIGTERM` first, then `SIGKILL` after a two-second grace
period. The group keeps being chased until a TERM-ignoring descendant is gone.
