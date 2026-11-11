---
"gcb-core": minor
"gcb-client": minor
"gcb-host": minor
---

Allow host-broker requests made outside a checkout to use the shared
`~/.gcb-host/channel`; they still require an explicit `--repo` and the same allowlist and account
checks. The channel is a pre-created, host-owned 0700 directory; the broker validates it and does
not create or chmod it.
