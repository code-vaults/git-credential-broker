---
"gcb-host": patch
---

Check `allowFork` through authenticated credentials instead of the unauthenticated public API: the
host uses its `gh` account, and the app provider uses the installation on the fork (rejecting a fork
without one). Both require a public fork and a public matched parent/source.
