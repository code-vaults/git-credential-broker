---
'gcb-core': minor
'gcb-host': minor
---

Add `allowUserCredential` for repositories where the App cannot be installed. When the installation
lookup returns 404 and the option is enabled, the GitHub App provider returns the same authorized
person token that bare `--as-user` uses (from `gcb authorize`). Without the
option or a person token the error names both requirements.
