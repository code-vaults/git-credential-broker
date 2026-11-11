---
"gcb-core": minor
"gcb-client": minor
"gcb-host": minor
---

Add `gcb push` (explicit host-executed push; a deliberate exception to native Git): the host broker pushes an exact commit with its own gh account, or its SSH
agent/key when the selected remote uses SSH. A destination fork is allowed when `allowForkPush` verifies its parent/source against the allowlist;
the command takes a git-style remote and branch, and the request carries the repository, remote,
branch, exact commit, optional force/lease expectation, account and proxy; `--force` and `--force-with-lease` are explicit. Other push arguments are not passed through; no token or container-controlled remote URL enters the host push.
The container runs its own `pre-push` hook; the host never runs container-owned hooks.
