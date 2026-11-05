---
'gcb-core': minor
---

Add `issue:lock`, `issue:unlock`, `issue:pin` and `issue:unpin` to the action catalog. Lock takes an
optional `--reason`; all four use `issues: write` and set `appUser`, so bare `--as-user` works through
the app broker. `issue:pin` and `issue:unpin` declare `target: issue` so a pull request number is refused by the
preflight instead of reaching the GraphQL mutation or returning an unpin no-op.
