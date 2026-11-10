---
"gcb-host": patch
---

Add `gcb authorize --broker-container` for the sidecar deployment: it explicitly allows writing the
refresh token inside the broker container's mounts, with a warning, instead of requiring a copy through
`/tmp`. It must not be used when the target is shared with the agent container.
