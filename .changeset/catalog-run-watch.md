---
'gcb-core': minor
---

Add `run:watch` to the action catalog. It polls a workflow run until it finishes, with optional
`--compact`, `--exit-status` and `--interval`. The timeout is 3300 seconds, five minutes below the
one-hour installation-token lifetime, so a poll cannot outlive the token. It uses `actions: read` and
`checks: read` (for annotations) and sets `appUser`.
