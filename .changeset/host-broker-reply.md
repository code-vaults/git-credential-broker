---
'gcb-client': minor
'gcb-core': minor
'gcb-host': minor
---

Add `gcb host` as the typed host broker: besides creating pull requests/issues and forking, it now
fulfils review replies. `--as-user <login> --reply-to` writes a typed reply request; the host broker validates the
repository/number/comment id, runs `gh api` with the selected account, and returns the reply URL.
An explicit `--repo` on a create/reply request is checked against the broker allowlist and needs no
checkout of that repository.
