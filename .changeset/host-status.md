---
'gcb-core': minor
'gcb-host': minor
---

Record the resolved config path, working directory and package version in a fixed host-private
`~/.gcb-host/status.json` (not beside a config and not in the container-writable channel marker), and
add `gcb host status [--json]` with no config argument. The status file is written at daemon startup
with `config: null`, updated after a successful config load, is read/written with
`readJson`/`writeJsonAtomic`, and is never read from the caller's cwd.
