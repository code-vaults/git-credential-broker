---
'gcb-core': minor
---

Add the read-side actions `pr:checks`, `pr:status`, `issue:view` and `issue:list` to the action
catalog. They use read-only permissions and are available through the ordinary client, host action
and allowlist routes. The unused `hostUser` catalog field is removed; the named-account host route
accepts any catalogued action.
