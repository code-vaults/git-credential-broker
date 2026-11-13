---
"gcb-host": patch
---

Centralize the gh token environment variables and host classification. GHES action execution now
uses `GH_ENTERPRISE_TOKEN` instead of the ignored `GH_TOKEN`, and the host account selectors share
one token-key helper.
