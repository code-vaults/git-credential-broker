---
"gcb-core": minor
"gcb-client": minor
"gcb-host": minor
---

Add `gcb push`: the host broker pushes an exact commit with its own gh account, or its SSH
agent/key when the selected remote uses SSH. The request carries only an allowlisted
repository, remote, branch and commit; `--force` and `--force-with-lease` are explicit. Other push arguments are not passed through; no token or container-controlled remote URL enters the host push.
The container runs its own `pre-push` hook; the host never runs container-owned hooks.
