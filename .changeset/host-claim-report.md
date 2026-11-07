---
'gcb-core': patch
'gcb-host': patch
---

Report requests left in a working file by a host broker that exited, instead of leaving them to
disappear silently. Recovery never executes the action again: it writes an explicit outcome-unknown
error for the caller to retry manually, and keeps an answer that was already written.
