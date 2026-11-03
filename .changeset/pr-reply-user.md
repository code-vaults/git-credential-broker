---
'gcb-client': minor
---

Allow bare `--as-user` with `--reply-to`, `--edit` and `--comment`, so review replies and comment
changes are attributed to the broker's authorized person (or an owner `userTokens` entry) instead of
the app. `--as-user <login>` still only creates, because the host opener is create-only.
