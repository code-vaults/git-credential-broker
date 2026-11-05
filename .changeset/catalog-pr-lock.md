---
'gcb-core': minor
---

Add `pr:lock` and `pr:unlock` to the action catalog. Lock takes an optional `--reason`; both use
`pull_requests: write`. The permission was verified with a token limited to `pull_requests: write`,
and an `issues: write` token was refused.
