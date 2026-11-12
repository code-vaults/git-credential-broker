# gcb-client

## 0.11.1

### Patch Changes

- [#157](https://github.com/code-vaults/git-credential-broker/pull/157) [`03d1a95`](https://github.com/code-vaults/git-credential-broker/commit/03d1a959580f6cc76f6ea479ecafd614265b4ab6) Thanks [@JounQin](https://github.com/JounQin)! - Add `pr:review-edit <number> <id> --body`: update the body of an existing pull request review
  through the fixed `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}` endpoint.
- Updated dependencies [[`03d1a95`](https://github.com/code-vaults/git-credential-broker/commit/03d1a959580f6cc76f6ea479ecafd614265b4ab6)]:
  - gcb-core@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [[`5977e71`](https://github.com/code-vaults/git-credential-broker/commit/5977e71f7e27fb1b35e4c83a3f569f4fad5a2833)]:
  - gcb-core@0.11.0

## 0.10.0

### Minor Changes

- [#147](https://github.com/code-vaults/git-credential-broker/pull/147) [`cdb5364`](https://github.com/code-vaults/git-credential-broker/commit/cdb5364568d4012c16ad9d46bb367ec9367d5b11) Thanks [@JounQin](https://github.com/JounQin)! - Remove the transitional `gcb pr --close` tombstone and the `--as-user owner/name` overload on
  `gcb repo fork`; use `gcb pr close` and the positional repository respectively.

### Patch Changes

- Updated dependencies [[`96829bf`](https://github.com/code-vaults/git-credential-broker/commit/96829bfd3ae2b169eb6c05fb75d593b08541ef2f), [`9964a33`](https://github.com/code-vaults/git-credential-broker/commit/9964a33c84f0267110424f2ea9edbfe37bec74db), [`3d936af`](https://github.com/code-vaults/git-credential-broker/commit/3d936afc2bf8ca41f1ddb3d8140d8150401f127a), [`08d4ef4`](https://github.com/code-vaults/git-credential-broker/commit/08d4ef407c44141b45a67bfe95ba92122d5f2de9), [`af188bd`](https://github.com/code-vaults/git-credential-broker/commit/af188bd195df2cac8de8a314c1f31fddab6456d8)]:
  - gcb-core@0.10.0

## 0.9.0

### Minor Changes

- [#142](https://github.com/code-vaults/git-credential-broker/pull/142) [`d26ea16`](https://github.com/code-vaults/git-credential-broker/commit/d26ea16a5c0df22e4865ee3947009a3be1266297) Thanks [@i1stG](https://github.com/i1stG)! - Allow host-broker requests made outside a checkout to use the shared
  `~/.gcb-host/channel`; they still require an explicit `--repo` and the same allowlist and account
  checks. The channel is a pre-created, host-owned 0700 directory; the broker validates it and does
  not create or chmod it.

- [#136](https://github.com/code-vaults/git-credential-broker/pull/136) [`bcc1373`](https://github.com/code-vaults/git-credential-broker/commit/bcc1373cedabeca2d267bd07ab85db15e98895a2) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb push` (explicit host-executed push; a deliberate exception to native Git): the host broker pushes an exact commit with its own gh account, or its SSH
  agent/key when the selected remote uses SSH. A destination fork is allowed when `allowForkPush` verifies its parent/source against the allowlist;
  the command takes a git-style remote and branch, and the request carries the repository, remote,
  branch, exact commit, optional force/lease expectation, account and proxy; `--force` and `--force-with-lease` are explicit. Other push arguments are not passed through; no token or container-controlled remote URL enters the host push.
  The container runs its own `pre-push` hook; the host never runs container-owned hooks.

### Patch Changes

- Updated dependencies [[`d26ea16`](https://github.com/code-vaults/git-credential-broker/commit/d26ea16a5c0df22e4865ee3947009a3be1266297), [`bcc1373`](https://github.com/code-vaults/git-credential-broker/commit/bcc1373cedabeca2d267bd07ab85db15e98895a2)]:
  - gcb-core@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies []:
  - gcb-core@0.8.1

## 0.8.0

### Minor Changes

- [#127](https://github.com/code-vaults/git-credential-broker/pull/127) [`d311cb0`](https://github.com/code-vaults/git-credential-broker/commit/d311cb09b88766f3fce6f7877d6da81d205526a0) Thanks [@JounQin](https://github.com/JounQin)! - Search actions accept multiple positional terms (or one quoted phrase): the final positional is
  repeatable, and each term is passed to `gh` as its own argument after `--`. Repository-scope
  qualifier rejection applies to every term.

### Patch Changes

- Updated dependencies [[`9ae646c`](https://github.com/code-vaults/git-credential-broker/commit/9ae646c2df2d6c9fc0f8b4e73e1e597e8cba9063), [`5d93ad4`](https://github.com/code-vaults/git-credential-broker/commit/5d93ad4f05d54150afd66bcb2b531e70a38c86a8), [`d311cb0`](https://github.com/code-vaults/git-credential-broker/commit/d311cb09b88766f3fce6f7877d6da81d205526a0)]:
  - gcb-core@0.8.0

## 0.7.1

### Patch Changes

- Updated dependencies []:
  - gcb-core@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [[`d247ec5`](https://github.com/code-vaults/git-credential-broker/commit/d247ec5cdd624e1c45376f887ae25405bdbeb1c9), [`b83dd51`](https://github.com/code-vaults/git-credential-broker/commit/b83dd51e012f7566202b5d31c8dca7a9580087e5), [`70eff30`](https://github.com/code-vaults/git-credential-broker/commit/70eff304474522fba9b0383d90918bbe9470abdb), [`68eb0ff`](https://github.com/code-vaults/git-credential-broker/commit/68eb0ff8080226f2f6eb1d03ba9517da5278b7c2), [`80e697f`](https://github.com/code-vaults/git-credential-broker/commit/80e697fe2183952f5612a7f29d2a6ba3830e489e), [`eee2074`](https://github.com/code-vaults/git-credential-broker/commit/eee207439cb643d1d0f49895609bb17f6bbda639), [`f596356`](https://github.com/code-vaults/git-credential-broker/commit/f596356b30413001c9dee30621b978cb2bd69e88)]:
  - gcb-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [[`9ad2d26`](https://github.com/code-vaults/git-credential-broker/commit/9ad2d26139b8fd4e6875ce2279494f2b29ad8e0b), [`fdf3ff6`](https://github.com/code-vaults/git-credential-broker/commit/fdf3ff6779080573cd6fcae62e7b8156898352c2), [`51054d0`](https://github.com/code-vaults/git-credential-broker/commit/51054d0042306c6e14bf141e2fef0b53426c62af)]:
  - gcb-core@0.6.0

## 0.5.0

### Minor Changes

- [#81](https://github.com/code-vaults/git-credential-broker/pull/81) [`93889a4`](https://github.com/code-vaults/git-credential-broker/commit/93889a430f5b906fec6d57b2bcbe1251ce8e9791) Thanks [@JounQin](https://github.com/JounQin)! - Dispatch catalogued `pr` and `issue` subcommands through one primary adapter. `gh` remains the
  default; `GCB_PRIMARY` selects the adapter and an unsupported name fails closed.
  `gcb issue` is now the same catalog shell as `gcb gh issue`, so its separate host-submit module is
  gone; the host login form is `gcb gh issue ... --as-user <login>`. `--body-file -` reads the
  body from standard input, matching `gh`. `gcb gh` accepts both `--as-user` forms: bare for actions the app broker
  can run as a person, and a login for the catalogued action through the host broker. The host request carries the action
  name and typed values; the broker rebuilds argv from the catalog.

  The host-broker channel is named consistently now: `GCB_HOST_TIMEOUT_MS` replaces `GCB_OPENER_TIMEOUT_MS`, the marker file is `host-broker.json`, the channel directory is `gcb/host-broker`, and the core helpers are `readHostBroker`/`writeHostBroker`/`clearHostBroker`; the `gcb-core` result type is now `HostResult`, not `HostOpenResult`. Client and host must be upgraded together; the host program override is `GCB_HOST_COMMAND`.

### Patch Changes

- Updated dependencies [[`51f0a65`](https://github.com/code-vaults/git-credential-broker/commit/51f0a65babcb9585a9ef56a5eeb754c9adc54bf0), [`5dedb25`](https://github.com/code-vaults/git-credential-broker/commit/5dedb25dbb47fd61f85bed444f1744214addcc22), [`705c139`](https://github.com/code-vaults/git-credential-broker/commit/705c13916643a4951476240b84f732feb236b964), [`e5bd34e`](https://github.com/code-vaults/git-credential-broker/commit/e5bd34ecabda5510763eef6e8689f6c3c14b0316), [`914535b`](https://github.com/code-vaults/git-credential-broker/commit/914535be1fb6223a0f055c2730fcaf304d976991)]:
  - gcb-core@0.5.0

## 0.4.0

### Minor Changes

- [#78](https://github.com/code-vaults/git-credential-broker/pull/78) [`75af9c8`](https://github.com/code-vaults/git-credential-broker/commit/75af9c8427ab72602ae43f6a82ab4458b3549ecf) Thanks [@JounQin](https://github.com/JounQin)! - Let a person submit a pull request review through the broker: bare `--as-user` uses the broker's
  authorized person through the app broker, while `--as-user <login>` writes a typed host request,
  checked against the broker allowlist, that runs `gh pr review` without a shell. `--approve`,
  `--request-changes` and `--review-comment` are the review events. `pr:edit` also supports the
  same person identities, so a pull request's title, body or base can be changed through the broker.
  The catalog also gains `issue:edit` and `issue:comment`, with the same app/person identity
  handling.

### Patch Changes

- Updated dependencies [[`75af9c8`](https://github.com/code-vaults/git-credential-broker/commit/75af9c8427ab72602ae43f6a82ab4458b3549ecf)]:
  - gcb-core@0.4.0

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
