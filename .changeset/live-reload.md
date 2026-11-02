---
'gcb-host': minor
---

Reload `broker.config.yml` without restarting: poll every 5 seconds, use a directory watch where
available, accept `SIGHUP`, keep the last good snapshot on a parse/validation failure, and swap
providers atomically. `socketPath`, `socketMode` and `auditPath` still need a restart.
