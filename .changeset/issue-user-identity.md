---
'gcb-client': minor
---

Allow bare `--as-user` for `issue create`, using the broker's authorized person or an owner
`userTokens` entry through the action token path. `--body-file` is translated to the catalogued `--body`, so it
works on the plain app route as well. `--as-user <login>` still creates through the host opener.
