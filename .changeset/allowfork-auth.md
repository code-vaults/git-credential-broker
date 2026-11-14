---
"gcb-host": patch
---

Check `allowFork` through the host's authenticated `gh` account instead of the unauthenticated
public API, whose shared-egress rate limit silently disabled the fork check.
