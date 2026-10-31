---
'gcb-core': minor
'gcb-client': minor
'gcb-host': minor
---

Add `gcb pr --as-user <login>` to create a pull request through the host opener using that person's
`~/.config/gh-<login>` configuration. `--via-host` is gone: the login names the route and the
account. The selected directory must exist before the request is made.
