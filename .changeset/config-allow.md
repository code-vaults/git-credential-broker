---
'gcb-host': minor
---

Add `gcb config allow add|remove <host> <owner/name>`. It edits one exact allowlist entry with
`parseDocument`, so comments and formatting survive; validates the result with the same loader as
the daemon; and replaces the file atomically. It serializes updates with a lock, refuses to remove
the last entry, and reports the reload as unconfirmed: the daemon watches the config directory, but
the command does not signal it, and restart-only keys still need a restart.
