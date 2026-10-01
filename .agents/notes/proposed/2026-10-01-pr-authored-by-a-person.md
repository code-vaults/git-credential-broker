# A second App, so a person can be the author of the pull request

Status: decided, not built.

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

A **second GitHub App**, holding only what creating a pull request needs, and a **user access token**
for it — the OAuth user-to-server flow. GitHub issues that token for the app *and* the person, so it
covers however many owners the person can reach, and it renews itself.

Permissions: **Pull requests: Read and write**, **Contents: Read-only**, **Metadata: Read-only**.
Nothing else — and in particular no contents write, so GitHub itself refuses to let the token push or
merge. That is the property worth having, and it is why this is a second App rather than user
authorization on the existing one: the existing app needs contents write to push branches, and a user
token carries the app's permissions, so it would carry that too.

Enable **Request user authorization (OAuth) during installation**, and leave **Expire user
authorization tokens** on: that is what produces a refresh token.

A deployment that does not want any of this configures nothing and behaves exactly as it does today.
Nothing is installed for a user who does not need it.

## Shape

- Configuration, on the host block: `oauthClientId` and `oauthClientSecretPath`, beside
  `privateKeyPath`. Absent means the feature is absent.
- `git-credential-broker authorize --config …` on the host: the device flow, printing a code and a URL
  once, then storing the refresh token in the deployment directory beside the key — outside every
  mount, and never in the repository.
- The broker refreshes on demand (the user token lasts eight hours) and writes the new refresh token
  back. A refresh failure disables the feature with a loud log line; it never fails a push.
- The token is used for `action: 'open'` and nothing else. Status, close, merge and update stay on the
  installation token, where the allowlist and the permission pre-flight live. A PR-creation token that
  cannot read a log or merge a branch is the point.
- The audit record keeps saying which actor was used, so "who opened this" is answerable from the
  host's log rather than from guesswork.

## Checklist

1. Config: `oauthClientId`, `oauthClientSecretPath`, validated like the key, absent by default.
2. `src/commands/authorize.ts`: device flow against `github.com/login/device/code` and
   `/login/oauth/access_token`, storing the refresh token with mode 600.
3. Provider: exchange the refresh token when it is about to create, cache the user token until it
   nears expiry, use it for `action: 'open'`.
4. Tests: refresh exchange, expiry, a failure not breaking a push, and the token being used for
   creation only.
5. Docs: the README section beside the `userTokens` one, and the AGENTS rule.
6. Still owed from the `userTokens` work: a test for it, and its AGENTS rule.
