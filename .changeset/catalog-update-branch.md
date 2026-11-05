---
'gcb-core': minor
---

Add `pr:update-branch` to the action catalog. It takes an optional `--rebase`, uses
`pull_requests: write` and `contents: write`, and sets `appUser`, so bare `--as-user` works through
the app broker. `appUser` follows `pr:edit`: updating a branch is an author operation, while
close/reopen/ready/lock stay host-account only. Bare `--as-user` needs a user token with
`contents: write`; the recommended `Contents: Read` token is enough for PR editing but not for
updating a branch. The default app route and `--as-user <login>` do not depend on that token. For a
PR whose head is a fork, the app installation token is scoped to the base repository and cannot
write the head fork; use `--as-user <login>` for that case.
