---
'gcb-core': minor
---

Add the `allowPublicRead` and `allowForkPush` host opt-ins. Catalog entries can now declare
`readOnly: true`; with `allowPublicRead`, such an action on a repository verified public without a
credential runs anonymously, with no allowlist entry and no person/App token. `allowForkPush` lets a
git credential request through for a repository whose GitHub parent/source is allowlisted, still
limited to the credential path; catalog actions keep the normal allowlist.

`allowPublicRead` runs the same path for app, bare `--as-user` and `--as-user <login>` requests,
without changing the existing identity policy. `allowForkPush` needs the App installed on the fork
owner, because the credential still comes from an installation token; a plain contributor fork
without that installation cannot mint one.
