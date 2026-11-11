---
"gcb-host": minor
---

Serialize refresh-token renewal and `gcb authorize` with a shared `user.refresh.lock` directory, and
replace the token under the lock. Re-authorizing a running sidecar no longer requires stopping it.
