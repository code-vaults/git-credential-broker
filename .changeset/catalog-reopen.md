---
'gcb-core': minor
---

Add `pr:reopen`, `issue:close` and `issue:reopen` to the action catalog. All three use a 60-second
timeout. `pr:reopen` is host-account only, like `pr:close`; `issue:close`/`issue:reopen` also set
`appUser`, so bare `--as-user` works through the app broker. The close/reopen comment flags were
left out: a closing comment is prose like an action body, and gh has no `--comment-file`, so
callers use the existing issue/pull-request comment actions instead.
