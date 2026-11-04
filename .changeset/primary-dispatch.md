---
'gcb-client': minor
---

Dispatch catalogued `pr` and `issue` subcommands through one primary adapter. `gh` remains the
default; `GCB_PRIMARY` selects the adapter and an unsupported name fails closed. Catalogued issue
actions no longer pass through a second forwarding layer in `gcb issue`. `--body-file -` reads the
body from standard input, matching `gh`. `gcb gh` accepts both `--as-user` forms: bare for `appUser`
actions, and a login for the catalogued action through the host broker. The host request carries the action
name and typed values; the broker rebuilds argv from the catalog.
