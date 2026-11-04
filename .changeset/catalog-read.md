---
'gcb-core': minor
---

Add the read-side actions `pr:checks`, `pr:status`, `issue:view` and `issue:list` to the action
catalog. `pr:checks` includes `pull_requests: read` because gh resolves the PR before reading
checks. The `--web` flags were left out: the broker runs headless, and `--json url --jq .url` gives
the URL. They are available through the ordinary client, host action and allowlist routes.
