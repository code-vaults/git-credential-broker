---
'gcb-client': patch
---

Accept `gcb pr create --as-user`, forwarding it to the flag-only pull-request lifecycle instead of
rejecting the obvious spelling; `gcb pr create` without `--as-user` remains the catalogued action.
