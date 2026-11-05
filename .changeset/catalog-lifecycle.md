---
'gcb-core': minor
---

Add `pr:ready`, `run:cancel` and `run:rerun` to the action catalog. `pr:ready` toggles draft state
with `--undo`; `run:cancel` supports `--force`, and `run:rerun` supports `--debug`, `--failed` and
`--job`; `--failed` with `--job` is refused because gh ignores the failed flag in job mode.
`run:cancel` and `run:rerun` set `appUser`, so bare `--as-user` works through the app
broker; `pr:ready` follows `pr:close`/`pr:reopen` as host-account only.
