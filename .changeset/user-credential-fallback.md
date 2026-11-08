---
'gcb-core': minor
'gcb-host': minor
---

Add `allowUserCredential` for repositories where the App cannot be installed. When the installation
lookup returns 404 and the option is enabled, the GitHub App provider returns the owner's
`userTokens[owner]` fine-grained token as the git credential. It does not fall back to the global
OAuth token, and without the option or an owner token the error names both requirements.
