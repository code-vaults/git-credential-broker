---
'gcb-core': minor
'gcb-client': minor
'gcb-host': minor
---

Make the pull-request identity explicit: `--as-app` uses the installation token (default),
`--as-user` without a login uses the broker's authorized user token, and `--as-user <login>` keeps
the host-opener route.
