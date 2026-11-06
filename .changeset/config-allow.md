---
'gcb-host': minor
---

Add `gcb config allow add|remove <host> <owner/name>`. It edits one exact allowlist entry with
`parseDocument`, so comments and formatting survive; validates the result with the same loader as
the daemon; and replaces the file atomically. The running daemon reloads through the config watcher
(or `SIGHUP`).
