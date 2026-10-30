---
'gcb-host': patch
---

Terminate a timed-out `gh` action with `SIGTERM` first, then `SIGKILL` after a two-second grace
period.
