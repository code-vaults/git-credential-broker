---
'gcb-client': minor
'gcb-core': minor
'gcb-host': minor
---

Let a person submit a pull request review through the broker: bare `--as-user` uses the broker's
authorized person, and `--as-user <login>` uses a host `gh` account. `--approve`,
`--request-changes` and `--review-comment` are typed review requests, checked against the broker
allowlist, and run `gh pr review` without a shell. `pr:edit` also supports the same person
identities, so a pull request's title, body or base can be changed through the broker. The catalog
also gains `issue:edit` and `issue:comment`, with the same app/person identity handling.
