---
"gcb-host": patch
---

Refuse `--as-user <login>` when `~/.config/gh-<login>` is logged in as another active user, instead
of silently performing the person action as that other account.
