---
'gcb-core': minor
'gcb-host': minor
---

Serve host-broker channels for submodules nested in a checkout, while keeping the one-level scan
bounded. Read `.git` pointers as bounded, non-blocking regular files. Check the App installation
before an app-routed action and refuse an uninstalled target with a `--as-user` hint, and add
`allowFork` so an allowlisted public fork can authorize a catalogued action on its public
parent/source after GitHub verifies the relationship.
