---
'gcb-core': minor
---

Add `run:watch` to the action catalog. It polls a workflow run until it finishes, with optional
`--compact`, `--exit-status` and `--interval`, and a 3600-second timeout so long runs are not cut off.
It uses `actions: read` and sets `appUser`.
