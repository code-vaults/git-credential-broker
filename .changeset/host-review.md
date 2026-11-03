---
'gcb-client': minor
'gcb-core': minor
'gcb-host': minor
---

Let a person submit a pull request review through the broker: bare `--as-user` uses the broker's
authorized person through the app broker, while `--as-user <login>` writes a typed host request,
checked against the broker allowlist, that runs `gh pr review` without a shell. `--approve`,
`--request-changes` and `--review-comment` are the review events. `pr:edit` also supports the
same person identities, so a pull request's title, body or base can be changed through the broker.
The catalog also gains `issue:edit` and `issue:comment`, with the same app/person identity
handling.
