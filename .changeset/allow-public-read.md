---
'gcb-core': minor
---

Add the `allowPublicRead` and `allowForkPush` host opt-ins. Catalog entries can now declare
`readOnly: true`; with `allowPublicRead`, such an action on a repository verified public without a
credential runs without an allowlist entry.

The app route mints a metadata-only installation token; the App must be installed on the repository,
and the request is refused rather than falling back to anonymous when it is not, because `gh` needs
authentication. Visibility is checked freshly for each request, not cached. The unauthenticated check shares GitHub's
60/hour IP quota; an exhausted 403/429 is reported as a rate limit, a plain 403 as a refusal, and
neither as a private repository. The host route does not use this
exemption: its `gh` commands also need a token, so it keeps the normal allowlist. Neither path
uses a person token or the action's normal write permissions.

`allowPublicRead` uses the app identity; bare `--as-user` is refused on that path because the read
uses an App metadata token, not a person token. `--as-user <login>` goes through the host broker and
keeps the normal allowlist.

`allowForkPush` lets a git credential request through for a **public** fork whose GitHub
parent/source is allowlisted, still limited to the credential path; catalog actions keep the normal
allowlist. It needs the App installed on the fork owner, because the credential still comes from an
installation token; a plain contributor fork without that installation cannot mint one.
