---
"gcb-core": minor
"gcb-host": minor
---

Remove the unused `allowInsecureHttp` and `userTokens` configuration options. Credentials are
HTTPS-only, and person routes use the token written by `gcb authorize`; there is no per-owner token
fallback.
