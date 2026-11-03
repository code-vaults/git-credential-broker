# gcb-client

## 0.3.0

### Minor Changes

- [#73](https://github.com/code-vaults/git-credential-broker/pull/73) [`afcbf78`](https://github.com/code-vaults/git-credential-broker/commit/afcbf7893b004dc4e92457ad11084b28534fbe0a) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb host` as the typed host broker: besides creating pull requests/issues and forking, it now
  fulfils review replies. `--as-user <login> --reply-to` writes a typed reply request; the host broker validates the
  repository/number/comment id, runs `gh api` with the selected account, and returns the reply URL.
  An explicit `--repo` on a create/reply request is checked against the broker allowlist and needs no
  checkout of that repository.

### Patch Changes

- Updated dependencies [[`afcbf78`](https://github.com/code-vaults/git-credential-broker/commit/afcbf7893b004dc4e92457ad11084b28534fbe0a)]:
  - gcb-core@0.3.0

## 0.2.0

### Minor Changes

- [#67](https://github.com/code-vaults/git-credential-broker/pull/67) [`2cf1043`](https://github.com/code-vaults/git-credential-broker/commit/2cf1043528463094e2c04753329d6b7a77737313) Thanks [@JounQin](https://github.com/JounQin)! - Allow bare `--as-user` for `issue create`, using the broker's authorized person or an owner
  `userTokens` entry through the action token path. `--body-file` is translated to the catalogued `--body`, so it
  works on the plain app route as well. `--as-user <login>` still creates through the host opener.

- [#67](https://github.com/code-vaults/git-credential-broker/pull/67) [`2cf1043`](https://github.com/code-vaults/git-credential-broker/commit/2cf1043528463094e2c04753329d6b7a77737313) Thanks [@JounQin](https://github.com/JounQin)! - Allow bare `--as-user` with `--reply-to`, `--edit` and `--comment`, so review replies and comment
  changes are attributed to the broker's authorized person (or an owner `userTokens` entry) instead of
  the app. `--as-user <login>` still only creates, because the host opener is create-only.

### Patch Changes

- [#67](https://github.com/code-vaults/git-credential-broker/pull/67) [`2cf1043`](https://github.com/code-vaults/git-credential-broker/commit/2cf1043528463094e2c04753329d6b7a77737313) Thanks [@JounQin](https://github.com/JounQin)! - Accept `gcb pr create --as-user`, forwarding it to the flag-only pull-request lifecycle instead of
  rejecting the obvious spelling; `gcb pr create` without `--as-user` remains the catalogued action.
- Updated dependencies []:
  - gcb-core@0.2.0

## 0.1.0

### Minor Changes

- [#50](https://github.com/code-vaults/git-credential-broker/pull/50) [`a7efb20`](https://github.com/code-vaults/git-credential-broker/commit/a7efb204e2fe75baf08f624e4f12951657961adf) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb pr --as-user <login>` to create a pull request through the host opener using that person's
  `~/.config/gh-<login>` configuration; `gcb issue create --as-user <login>` uses the same route.
  `--via-host` is gone: the login names the route and the account. The selected directory must exist before the request is made.

- [#55](https://github.com/code-vaults/git-credential-broker/pull/55) [`c47a3a5`](https://github.com/code-vaults/git-credential-broker/commit/c47a3a5ea58593b8b1427571426db4e3316e1612) Thanks [@JounQin](https://github.com/JounQin)! - Make the pull-request identity explicit: app installation token by default, `--as-user` without a
  login for the broker's authorized user token, and `--as-user <login>` for the host-opener route.

- [#56](https://github.com/code-vaults/git-credential-broker/pull/56) [`f4c8d71`](https://github.com/code-vaults/git-credential-broker/commit/f4c8d71679e8ca754c6f1fc870d64c61af13ea91) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb repo fork [owner/name]`: create a fork under a person's account with `--as-user` (broker
  authorized user or host opener). The app identity cannot own a fork, so it is refused.

### Patch Changes

- [#57](https://github.com/code-vaults/git-credential-broker/pull/57) [`28fa646`](https://github.com/code-vaults/git-credential-broker/commit/28fa64613db41314afc3512c6923630158d367a5) Thanks [@JounQin](https://github.com/JounQin)! - Fail loudly when `pr --threads` gets no review-thread report instead of printing nothing; a malformed,
  structurally incomplete, or missing-field GraphQL response is no longer reported as "no review
  threads". Refused pull-request actions are audited as `pull-request`, not `credential`.
- Updated dependencies [[`a7efb20`](https://github.com/code-vaults/git-credential-broker/commit/a7efb204e2fe75baf08f624e4f12951657961adf), [`c47a3a5`](https://github.com/code-vaults/git-credential-broker/commit/c47a3a5ea58593b8b1427571426db4e3316e1612), [`f4c8d71`](https://github.com/code-vaults/git-credential-broker/commit/f4c8d71679e8ca754c6f1fc870d64c61af13ea91)]:
  - gcb-core@0.1.0

## 0.0.3

### Patch Changes

- [#47](https://github.com/code-vaults/git-credential-broker/pull/47) [`3ecc3d6`](https://github.com/code-vaults/git-credential-broker/commit/3ecc3d6b17ab513294197a6bedd86affb13dc4a0) Thanks [@JounQin](https://github.com/JounQin)! - Add the `gcb issue <subcommand>` shorthand for catalogued issue actions.
- Updated dependencies []:
  - gcb-core@0.0.3

## 0.0.2

### Patch Changes

- [#43](https://github.com/code-vaults/git-credential-broker/pull/43) [`92a28e4`](https://github.com/code-vaults/git-credential-broker/commit/92a28e4ed8d1048ec1d712ea47ea3c32dc65f18a) Thanks [@JounQin](https://github.com/JounQin)! - Default `gcb probe` and `gcb logs` to `github.com`, name the rendered sidecar file
  `docker-compose.yml` in the deployment directory, and document the deployment layout and the
  `--user` requirement.

- [#40](https://github.com/code-vaults/git-credential-broker/pull/40) [`25b46e3`](https://github.com/code-vaults/git-credential-broker/commit/25b46e33aabf29540df1aeddb72e43947f9a4da8) Thanks [@JounQin](https://github.com/JounQin)! - Read one pull request review with `gcb pr review --number <n> --id <id>`.
  
  When `--jq` is used, the action token is kept in the isolated gh config instead of the
  environment, so the expression cannot print it.
- Updated dependencies [[`25b46e3`](https://github.com/code-vaults/git-credential-broker/commit/25b46e33aabf29540df1aeddb72e43947f9a4da8)]:
  - gcb-core@0.0.2

## 0.0.1

### Patch Changes

- [#33](https://github.com/code-vaults/git-credential-broker/pull/33) [`4bab834`](https://github.com/code-vaults/git-credential-broker/commit/4bab834c781e6175b6b6e588ad542fa09d532be7) Thanks [@JounQin](https://github.com/JounQin)! - Prepare the first public release of the renamed packages.
- Updated dependencies [[`4bab834`](https://github.com/code-vaults/git-credential-broker/commit/4bab834c781e6175b6b6e588ad542fa09d532be7)]:
  - gcb-core@0.0.1
