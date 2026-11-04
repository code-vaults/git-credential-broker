# gcb-core

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
