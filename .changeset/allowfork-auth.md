---
"gcb-host": patch
---

Check `allowFork` through the host's authenticated `gh` account instead of the unauthenticated
public API, whose shared-egress rate limit silently disabled the fork check. The authenticated response must also
report a public fork and a public matched parent/source, so a private relationship cannot widen the
allowlist to its upstream.
