---
"gcb-host": patch
---

Reload the host broker's configuration on watch/poll/SIGHUP, as the app daemon already does, and let
`allowFork` cover lifecycle `gcb pr create` on the parent of an allowlisted fork.
