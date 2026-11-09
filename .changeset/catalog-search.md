---
'gcb-core': minor
---

Add repo-scoped search actions: `search:issues` (`issues: read`) and `search:prs`
(`pull_requests: read`). The broker still injects `--repo`, and rejects `repo:` / `org:` / `user:` qualifiers in the query, so a search cannot escape the allowlist.
