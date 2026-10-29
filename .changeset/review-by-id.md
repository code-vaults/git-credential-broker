---
'gcb-core': patch
'gcb-client': patch
'gcb-host': patch
---

Read one pull request review with `gcb pr review --number <n> --id <id>`.

When `--jq` is used, the action token is kept in the isolated gh config instead of the
environment, so the expression cannot print it.
