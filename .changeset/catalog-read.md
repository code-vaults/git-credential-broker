---
'gcb-core': minor
---

Add the read-side actions `pr:checks`, `pr:status`, `issue:view` and `issue:list` to the action
catalog. `pr:checks` includes `pull_requests: read` because gh resolves the PR before reading
checks. The `--web` flags were left out: the broker runs headless, and `--json` can return the URL
(`url` for issues, `link` for checks). They are available through the ordinary client, host action
and allowlist routes.

`--jq` on a host action runs with a minimal environment (PATH/HOME/GH_CONFIG_DIR/proxy), so it
cannot read the broker's inherited secrets; when a proxy URL contains credentials the action is
refused, because gh evaluates jq inside the process that holds the proxy environment. A host
deployment whose only login is `GH_TOKEN` keeps working: the token is copied to a temporary gh config
(mode 0600) for that jq action, not inherited through the environment.
