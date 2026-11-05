---
'gcb-core': minor
---

Add `pr:ready`, `run:cancel` and `run:rerun` to the action catalog. `pr:ready` toggles draft state
with `--undo`; `run:cancel` supports `--force`; `run:rerun` accepts exactly one of a run id or
`--job`, and rejects `--failed` with `--job` because gh ignores the failed flag in job mode.
`run:cancel` and `run:rerun` set `appUser`, so bare `--as-user` works through the app broker;
`pr:ready` stays host-account only for that form, like `pr:close`/`pr:reopen`.
