---
'gcb-core': minor
---

Add `run:cancel` and `run:rerun` to the action catalog. `run:cancel` supports `--force`;
`run:rerun` accepts exactly one of a run id or `--job`, and rejects `--failed` with `--job` because
gh ignores the failed flag in job mode. Both set `appUser`, so bare `--as-user` works through the
app broker.
