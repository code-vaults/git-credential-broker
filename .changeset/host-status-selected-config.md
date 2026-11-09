---
'gcb-host': patch
---

`gcb host status` now records the selected configuration path at daemon startup, before the lazy
`loadConfig`, so a daemon started with `--config` (or `GIT_BROKER_CONFIG`, or an existing default)
never reports `config: null`. A config-less daemon still reports null.
