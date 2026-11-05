---
'gcb-core': minor
---

Add `pr:ready`, `run:cancel` and `run:rerun` to the action catalog. `pr:ready` toggles draft state
with `--undo`; `run:cancel` supports `--force`, and `run:rerun` supports `--debug`, `--failed` and
`--job`. All three set `appUser`, so bare `--as-user` works through the app broker.
