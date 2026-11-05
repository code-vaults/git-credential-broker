---
'gcb-core': minor
---

Add `pr:update-branch` to the action catalog. It takes an optional `--rebase`, uses
`pull_requests: write` and `contents: write`, and sets `appUser`, so bare `--as-user` works through
the app broker.
