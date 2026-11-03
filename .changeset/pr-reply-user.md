---
'gcb-client': minor
---

Allow bare `--as-user` with `--reply-to`, so a review reply is attributed to the broker's authorized
person (or an owner `userTokens` entry) instead of the app. `--as-user <login>` still only creates,
because the host opener is create-only.
