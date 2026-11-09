---
'gcb-core': minor
---

Add `issue:comment-edit` (`issues: write`) and `pr:comment-edit` (`pull_requests: write`), which
PATCH one issue/PR conversation comment through a fixed gh api endpoint. The body travels in an
`--input` JSON file, never in argv. `pr:comment` also gains the person route, matching
`issue:comment`.
