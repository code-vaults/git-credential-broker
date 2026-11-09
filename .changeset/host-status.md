---
'gcb-core': minor
'gcb-host': minor
---

Record the resolved config path, working directory and package version in the host-broker marker,
and add `gcb host status [--repo <checkout>] [--json]` to report the running daemon from that
startup state instead of inferring it from `/proc`.
