---
"gcb-core": minor
"gcb-client": minor
"gcb-host": minor
---

Add `gcb push`: the host broker pushes an exact commit with its own gh account or, when
`pushTransport: ssh` is configured, its SSH agent/key. The request carries only an allowlisted
repository, branch and commit; no token or container-controlled remote URL enters the host push.
The container runs its own `pre-push` hook; the host never runs container-owned hooks.
