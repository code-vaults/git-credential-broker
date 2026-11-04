---
'gcb-core': minor
---

Add the read-side actions `pr:checks`, `pr:status`, `issue:view` and `issue:list` to the action
catalog. `pr:checks` includes `pull_requests: read` because gh resolves the PR before reading
checks. The `--web` flags were left out: the broker runs headless, and `--json` can return the URL
(`url` for issues, `link` for checks). They are available through the ordinary client, host action
and allowlist routes.

`--jq` is refused when a proxy URL contains credentials: gh evaluates jq inside the process that
holds the proxy environment, so an expression could otherwise read the proxy password.
