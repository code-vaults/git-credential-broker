---
'gcb-core': minor
---

Add `issue:comment-edit`, which PATCHes one issue comment through a fixed gh api endpoint. The body
travels in an `--input` JSON file, never in argv; the action requires `issues: write`.
