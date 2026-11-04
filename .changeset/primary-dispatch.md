---
'gcb-client': minor
---

Dispatch catalogued `pr` and `issue` subcommands through one primary adapter. `gh` remains the
default; `GCB_PRIMARY` selects the adapter and an unsupported name fails closed. Catalogued issue
actions no longer pass through a second forwarding layer in `gcb issue`.
