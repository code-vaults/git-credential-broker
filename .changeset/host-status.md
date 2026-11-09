---
'gcb-core': minor
'gcb-host': minor
---

Record the resolved config path, working directory and package version in a host-private
`host-status.json` beside the configuration (not in the container-writable channel marker), and add
`gcb host status --config <file> [--json]`. The status file is written at daemon startup with
`config: null`, updated after a successful config load, and read/written with the private JSON helpers.
