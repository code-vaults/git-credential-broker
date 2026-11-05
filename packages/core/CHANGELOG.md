# gcb-core

## 0.5.0

### Minor Changes

- [#95](https://github.com/code-vaults/git-credential-broker/pull/95) [`51f0a65`](https://github.com/code-vaults/git-credential-broker/commit/51f0a65babcb9585a9ef56a5eeb754c9adc54bf0) Thanks [@JounQin](https://github.com/JounQin)! - Add `issue:lock`, `issue:unlock`, `issue:pin` and `issue:unpin` to the action catalog. Lock takes an
  optional `--reason`; all four use `issues: write` and set `appUser`, so bare `--as-user` works through
  the app broker. `issue:pin` and `issue:unpin` declare `target: issue` so a pull request number is refused by the
  preflight instead of reaching the GraphQL mutation or returning an unpin no-op.

- [#91](https://github.com/code-vaults/git-credential-broker/pull/91) [`5dedb25`](https://github.com/code-vaults/git-credential-broker/commit/5dedb25dbb47fd61f85bed444f1744214addcc22) Thanks [@JounQin](https://github.com/JounQin)! - Add `pr:ready`, `run:cancel` and `run:rerun` to the action catalog. `pr:ready` toggles draft state
  with `--undo`; `run:cancel` supports `--force`; `run:rerun` accepts exactly one of a run id or
  `--job`, and rejects `--failed` with `--job` because gh ignores the failed flag in job mode.
  `run:cancel` and `run:rerun` set `appUser`, so bare `--as-user` works through the app broker;
  `pr:ready` stays host-account only for that form, like `pr:close`/`pr:reopen`.

- [#97](https://github.com/code-vaults/git-credential-broker/pull/97) [`705c139`](https://github.com/code-vaults/git-credential-broker/commit/705c13916643a4951476240b84f732feb236b964) Thanks [@JounQin](https://github.com/JounQin)! - Add `pr:lock` and `pr:unlock` to the action catalog. Lock takes an optional `--reason`; both use
  `pull_requests: write`. The permission was verified with a token limited to `pull_requests: write`,
  and an `issues: write` token was refused.

- [#89](https://github.com/code-vaults/git-credential-broker/pull/89) [`e5bd34e`](https://github.com/code-vaults/git-credential-broker/commit/e5bd34ecabda5510763eef6e8689f6c3c14b0316) Thanks [@JounQin](https://github.com/JounQin)! - Add the read-side actions `pr:checks`, `pr:status`, `issue:view` and `issue:list` to the action
  catalog. They use read-only permissions and are available through the ordinary client, host action
  and allowlist routes. The unused `hostUser` catalog field is removed; the named-account host route
  accepts any catalogued action.

- [#88](https://github.com/code-vaults/git-credential-broker/pull/88) [`914535b`](https://github.com/code-vaults/git-credential-broker/commit/914535be1fb6223a0f055c2730fcaf304d976991) Thanks [@JounQin](https://github.com/JounQin)! - Add `pr:reopen`, `issue:close` and `issue:reopen` to the action catalog. All three use a 60-second
  timeout. `pr:reopen` is host-account only, like `pr:close`; `issue:close`/`issue:reopen` also set
  `appUser`, so bare `--as-user` works through the app broker. The two issue actions also verify that
  the number is an issue, not a pull request, before executing; gh's issue close would otherwise close
  a PR. The comment flags for close and reopen were left out: a closing comment is prose like an
  action body, and gh has no `--comment-file`, so callers use the existing issue/pull-request comment
  actions instead.

## 0.4.0

### Minor Changes

- [#78](https://github.com/code-vaults/git-credential-broker/pull/78) [`75af9c8`](https://github.com/code-vaults/git-credential-broker/commit/75af9c8427ab72602ae43f6a82ab4458b3549ecf) Thanks [@JounQin](https://github.com/JounQin)! - Let a person submit a pull request review through the broker: bare `--as-user` uses the broker's
  authorized person through the app broker, while `--as-user <login>` writes a typed host request,
  checked against the broker allowlist, that runs `gh pr review` without a shell. `--approve`,
  `--request-changes` and `--review-comment` are the review events. `pr:edit` also supports the
  same person identities, so a pull request's title, body or base can be changed through the broker.
  The catalog also gains `issue:edit` and `issue:comment`, with the same app/person identity
  handling.

## 0.3.0

### Minor Changes

- [#73](https://github.com/code-vaults/git-credential-broker/pull/73) [`afcbf78`](https://github.com/code-vaults/git-credential-broker/commit/afcbf7893b004dc4e92457ad11084b28534fbe0a) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb host` as the typed host broker: besides creating pull requests/issues and forking, it now
  fulfils review replies. `--as-user <login> --reply-to` writes a typed reply request; the host broker validates the
  repository/number/comment id, runs `gh api` with the selected account, and returns the reply URL.
  An explicit `--repo` on a create/reply request is checked against the broker allowlist and needs no
  checkout of that repository.

## 0.2.0

No changes in this release.

## 0.1.0

### Minor Changes

- [#50](https://github.com/code-vaults/git-credential-broker/pull/50) [`a7efb20`](https://github.com/code-vaults/git-credential-broker/commit/a7efb204e2fe75baf08f624e4f12951657961adf) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb pr --as-user <login>` to create a pull request through the host opener using that person's
  `~/.config/gh-<login>` configuration; `gcb issue create --as-user <login>` uses the same route.
  `--via-host` is gone: the login names the route and the account. The selected directory must exist before the request is made.

- [#55](https://github.com/code-vaults/git-credential-broker/pull/55) [`c47a3a5`](https://github.com/code-vaults/git-credential-broker/commit/c47a3a5ea58593b8b1427571426db4e3316e1612) Thanks [@JounQin](https://github.com/JounQin)! - Make the pull-request identity explicit: app installation token by default, `--as-user` without a
  login for the broker's authorized user token, and `--as-user <login>` for the host-opener route.

- [#56](https://github.com/code-vaults/git-credential-broker/pull/56) [`f4c8d71`](https://github.com/code-vaults/git-credential-broker/commit/f4c8d71679e8ca754c6f1fc870d64c61af13ea91) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb repo fork [owner/name]`: create a fork under a person's account with `--as-user` (broker
  authorized user or host opener). The app identity cannot own a fork, so it is refused.

## 0.0.3

No changes in this release.

## 0.0.2

### Patch Changes

- [#40](https://github.com/code-vaults/git-credential-broker/pull/40) [`25b46e3`](https://github.com/code-vaults/git-credential-broker/commit/25b46e33aabf29540df1aeddb72e43947f9a4da8) Thanks [@JounQin](https://github.com/JounQin)! - Read one pull request review with `gcb pr review --number <n> --id <id>`.
  
  When `--jq` is used, the action token is kept in the isolated gh config instead of the
  environment, so the expression cannot print it.

## 0.0.1

### Patch Changes

- [#33](https://github.com/code-vaults/git-credential-broker/pull/33) [`4bab834`](https://github.com/code-vaults/git-credential-broker/commit/4bab834c781e6175b6b6e588ad542fa09d532be7) Thanks [@JounQin](https://github.com/JounQin)! - Prepare the first public release of the renamed packages.
