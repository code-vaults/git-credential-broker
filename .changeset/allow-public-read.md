---
'gcb-core': minor
---

Add the `allowPublicRead` and `allowForkPush` host opt-ins. Catalog entries can now declare
`readOnly: true`; with `allowPublicRead`, such an action on a repository verified public without a
credential runs without an allowlist entry.

The app route mints a metadata-only installation token; without an installation it refuses rather
than falling back to anonymous, because `gh` needs authentication. The host route does not use this
exemption: its `gh` commands also need a token, so it keeps the normal allowlist. Neither path
uses a person token or the action's normal write permissions.

`allowPublicRead` runs for the app, bare `--as-user` and `--as-user <login>` identities on the app
route, without changing the existing identity policy; the host route keeps the allowlist.

`allowForkPush` lets a git credential request through for a repository whose GitHub parent/source is
allowlisted, still limited to the credential path; catalog actions keep the normal allowlist. It
needs the App installed on the fork owner, because the credential still comes from an installation
token; a plain contributor fork without that installation cannot mint one.
