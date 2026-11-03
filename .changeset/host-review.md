---
'gcb-client': minor
'gcb-core': minor
'gcb-host': minor
---

Let a person submit a pull request review through the broker: bare `--as-user` uses the broker's
authorized person, and `--as-user <login>` uses a host `gh` account. `--approve`,
`--request-changes` and `--review-comment` are typed review requests, checked against the broker
allowlist, and run `gh pr review` without a shell.
