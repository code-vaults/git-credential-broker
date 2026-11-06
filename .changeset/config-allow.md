---
'gcb-host': minor
---

Add `gcb config allow add|remove <host> <owner/name>` for one exact entry. Globs, URLs, wildcards
and a `.git` suffix are refused. It edits the entry with `parseDocument`, so comments and formatting
survive, keeps LF or CRLF line endings, rejects mixed endings, validates the result with the same
loader as the daemon, and replaces the file atomically.
It also rejects host keys that differ only by case, which would otherwise leave one block silently
unreachable. It serializes allow updates with a target-keyed lock, refuses to remove the last
entry, and reports one line with `entry=… reload=unconfirmed signal=unavailable`: the daemon
watches the config directory, but the command does not signal it, and restart-only keys still need a
restart. `config edit` stays an in-place editor and needs no directory write. A lock left by a
crash fails closed and names the path for an operator to remove.
