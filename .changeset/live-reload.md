---
'gcb-host': minor
---

Reload `broker.config.yml` without restarting: use a directory watch plus a 5-second safety poll, accept `SIGHUP`, keep the last good snapshot on a parse/validation failure, and swap
providers atomically. `socketPath`, `socketMode` and `auditPath` still need a restart.
