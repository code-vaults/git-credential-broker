---
'gcb-core': patch
'gcb-host': patch
---

Report requests left in a working file by a host broker that exited, instead of leaving them to
disappear silently. Recovery never executes the action again: it writes an explicit outcome-unknown
error for the caller to verify before retrying, and keeps an answer that was already written.
A claim whose recorded owner is still alive is never recovered, regardless of age, and the recovery
error is published only if no result exists, so it cannot overwrite a real answer.
