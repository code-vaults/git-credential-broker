---
'gcb-client': minor
---

Dispatch catalogued `pr` and `issue` subcommands through one primary adapter. `gh` remains the
default; `GCB_PRIMARY` selects the adapter and an unsupported name fails closed. Catalogued issue
`gcb issue` is now the same catalog shell as `gcb gh issue`, so its separate host-submit module is
gone; the host login form is `gcb gh issue ... --as-user <login>`. `--body-file -` reads the
body from standard input, matching `gh`. `gcb gh` accepts both `--as-user` forms: bare for `appUser`
actions, and a login for the catalogued action through the host broker. The host request carries the action
name and typed values; the broker rebuilds argv from the catalog.

The host-broker channel is named consistently now: `GCB_HOST_TIMEOUT_MS` replaces `GCB_OPENER_TIMEOUT_MS`, the marker file is `host-broker.json`, the channel directory is `gcb/host-broker`, and the core helpers are `readHostBroker`/`writeHostBroker`/`clearHostBroker`. Client and host must be upgraded together.
