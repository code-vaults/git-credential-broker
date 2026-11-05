---
'gcb-core': minor
---

Add the `allowPublicRead` and `allowForkPush` host opt-ins. Catalog entries can now declare
`readOnly: true`; with `allowPublicRead`, such an action on a repository verified public without an
allowlist entry.

The app identity uses a metadata-only installation token; the App must be installed on the
repository, and the request is refused rather than falling back to anonymous when it is not, because
`gh` needs authentication. Bare `--as-user` uses the authorized person token, and
`--as-user <login>` uses the host account token. The host route performs the same fresh public check
before running the action.

Visibility is checked freshly for each request, not cached, bounded at 10 seconds and refused on a
redirect. The check shares GitHub's 60/hour IP quota; an exhausted 403/429 is reported as a rate limit, a plain 403 as a refusal, and neither as a
private repository. Person tokens may themselves have private access; those forms rely on the
visibility check rather than a token scope.

`allowForkPush` lets a git credential request through for a **public** fork whose GitHub
parent/source is allowlisted, still limited to the credential path; catalog actions keep the normal
allowlist. It needs the App installed on the fork owner, because the credential still comes from an
installation token; a plain contributor fork without that installation cannot mint one.
