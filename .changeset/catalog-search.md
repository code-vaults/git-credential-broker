---
'gcb-core': minor
---

Add repo-scoped search actions: `search:issues` (`issues: read`) and `search:prs`
(`pull_requests: read`). The broker still injects `--repo`, so a search cannot escape the allowlist.
