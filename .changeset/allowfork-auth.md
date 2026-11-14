---
"gcb-host": patch
---

Check `allowFork` through the host's authenticated `gh` account instead of the unauthenticated
public API, whose shared-egress rate limit silently disabled the fork check. The authenticated response must also
report a public fork, so a private fork cannot widen the allowlist to its upstream.
