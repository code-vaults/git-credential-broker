---
'gcb-core': minor
'gcb-client': minor
'gcb-host': minor
---

Make the pull-request identity explicit: app installation token by default, `--as-user` without a
login for the broker's authorized user token, and `--as-user <login>` for the host-opener route.
Older brokers ignore the new `identity` field; upgrade `gcb-host` before relying on the default.
