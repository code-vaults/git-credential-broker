# A user token on the existing App, so a person can be the author of the pull request

Status: built. See `src/commands/authorize.ts`, `src/device-flow.ts`, and the second half of
`src/providers/github-app.ts`; the keys below are what shipped, not what was proposed.

## The problem

A pull request created with an installation token is authored by the app, and automated reviewers are
entitled to skip those — CodeRabbit skipped #2 for exactly that reason, and once its check was
required the merge queue had nothing to wait for.

Two answers exist in the tree. `pr --via-host` asks a host-side opener to create it with the
operator's own `gh` login; `userTokens` names a fine-grained token per owner. Both work. The first
costs a second process to keep running. The second costs one token per user or organization, because
that is the granularity GitHub gives a fine-grained token, and rotating all of them is the kind of
chore nobody keeps up.

## The decision

Enable **Request user authorization (OAuth) during installation** on the *existing* App, and use the
**user access token** it yields — the user-to-server flow. GitHub issues that token for the app *and*
the person, so it covers however many owners the person can reach, and it renews itself.

This began as a second App, holding only pull requests read and write plus contents read, so that the
token could not push or merge. That narrowing is real, and it is not free to give up: a user token
carries the app's permissions, so on the existing app — which needs contents write to push branches —
it can also push, submit a review and merge as that person, where an installation token cannot
approve at all. The second App traded convenience for that boundary; this trades the boundary for
convenience, on the judgement that one App is easier to live with.

Accepted knowingly, and "split it later" has a condition rather than a feeling: split when it stops
being acceptable that the broker can act as the person completely — several people sharing a
deployment, or handing the deployment to somebody else, are the obvious triggers. The code would not
change; only which client id and secret are configured.

## Shape

- Configuration, on the host block: `clientId` — already there for the JWT — and no client secret at all, since the device flow needs none. Beside
  `privateKeyPath`. Absent means the feature is absent.
- `git-credential-broker authorize --config …` on the host: the device flow, printing a code and a URL
  once, then storing the refresh token in the deployment directory beside the key — outside every
  mount, and never in the repository.
- The broker refreshes on demand (the user token lasts eight hours) and writes the new refresh token
  back. A refresh failure fails that one action with a loud log line in the host log; it never fails a push.
- The token is used for `action: 'open'` and `action: 'resolve'`, and for nothing else. Status, close, merge and update stay on the
  installation token, where the allowlist and the permission pre-flight live. A PR-creation token that
  cannot read a log or merge a branch is the point.
- The audit record keeps saying which actor was used, so "who opened this" is answerable from the
  host's log rather than from guesswork.

## Checklist

1. Config: `clientId`, present by default; no secret to place.
2. `src/commands/authorize.ts`: device flow against `github.com/login/device/code` and
   `/login/oauth/access_token`, storing the refresh token with mode 600.
3. Provider: exchange the refresh token when it is about to create, cache the user token until it
   nears expiry, use it for `action: 'open'`.
4. Tests: refresh exchange, expiry, a failure not breaking a push, and the token being used for
   creation only.
5. Docs: the README section beside the `userTokens` one, and the AGENTS rule.
6. Still owed from the `userTokens` work: a test for it, and its AGENTS rule.
