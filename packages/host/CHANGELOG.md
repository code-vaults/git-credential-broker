# gcb-host

## 0.7.0

### Minor Changes

- [#103](https://github.com/code-vaults/git-credential-broker/pull/103) [`c040d5e`](https://github.com/code-vaults/git-credential-broker/commit/c040d5e73f7eede891800f1cae8ad9b3903dbab6) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb config allow add|remove <host> <owner/name>` for one exact entry. Globs, URLs,
  wildcards and a `.git` suffix are refused. It edits the entry with `parseDocument`, so comments and
  formatting survive, keeps LF or CRLF line endings, rejects mixed endings, validates the result with
  the same loader as the daemon, and replaces the file atomically. It also rejects host keys that
  differ only by case, which would otherwise leave one block silently unreachable. It serializes
  allow updates with a target-keyed lock, refuses to remove the last entry, and reports one line with
  `entry=… reload=unconfirmed signal=unavailable`: the daemon watches the config directory, but the
  command does not signal it, and restart-only keys still need a restart. `config edit` stays an
  in-place editor and needs no directory write. A lock left by a crash fails closed and names the path
  for an operator to remove.

- [#119](https://github.com/code-vaults/git-credential-broker/pull/119) [`80e697f`](https://github.com/code-vaults/git-credential-broker/commit/80e697fe2183952f5612a7f29d2a6ba3830e489e) Thanks [@JounQin](https://github.com/JounQin)! - Record the resolved config path, working directory and package version in a fixed host-private
  `~/.gcb-host/status.json` (not beside a config and not in the container-writable channel marker), and
  add `gcb host status` (JSON, no options, no config argument). The status file is written at daemon startup
  with `config: null`, updated after a successful config load, is read/written with
  `readJson`/`writeJsonAtomic`, and is never read from the caller's cwd.

- [#108](https://github.com/code-vaults/git-credential-broker/pull/108) [`f596356`](https://github.com/code-vaults/git-credential-broker/commit/f596356b30413001c9dee30621b978cb2bd69e88) Thanks [@JounQin](https://github.com/JounQin)! - Serve host-broker channels for submodules nested in a checkout, while keeping the one-level scan
  bounded. Read `.git` pointers as bounded, non-blocking regular files. Check the App installation
  before an app-routed action and refuse an uninstalled target with a `--as-user` hint, and add
  `allowFork` so an allowlisted public fork can authorize a catalogued action on its public
  parent/source after GitHub verifies the relationship.

### Patch Changes

- [#104](https://github.com/code-vaults/git-credential-broker/pull/104) [`68eb0ff`](https://github.com/code-vaults/git-credential-broker/commit/68eb0ff8080226f2f6eb1d03ba9517da5278b7c2) Thanks [@JounQin](https://github.com/JounQin)! - Report requests left in a working file by a host broker that exited, instead of leaving them to
  disappear silently. Recovery never executes the action again: it writes an explicit outcome-unknown
  error for the caller to verify before retrying, and keeps an answer that was already written.
  A claim whose recorded owner is still alive is never recovered, regardless of age, and the recovery
  error is published only if no result exists, so it cannot overwrite a real answer.

- [#113](https://github.com/code-vaults/git-credential-broker/pull/113) [`5c35831`](https://github.com/code-vaults/git-credential-broker/commit/5c358312b303da5b590a6b333c313854cbda7169) Thanks [@i1stG](https://github.com/i1stG)! - Close the remaining `--jq` environment leak: gh already receives a whitelisted environment with the
  token in its isolated config, but a proxy URL carrying a username or password was still visible as
  `HTTPS_PROXY`. Such a proxy now makes `--jq` fail, so the expression
  cannot read proxy credentials. The host-broker route rejects `--jq` entirely, because its gh
  program inherits the selected host account environment.
- Updated dependencies [[`d247ec5`](https://github.com/code-vaults/git-credential-broker/commit/d247ec5cdd624e1c45376f887ae25405bdbeb1c9), [`b83dd51`](https://github.com/code-vaults/git-credential-broker/commit/b83dd51e012f7566202b5d31c8dca7a9580087e5), [`70eff30`](https://github.com/code-vaults/git-credential-broker/commit/70eff304474522fba9b0383d90918bbe9470abdb), [`68eb0ff`](https://github.com/code-vaults/git-credential-broker/commit/68eb0ff8080226f2f6eb1d03ba9517da5278b7c2), [`80e697f`](https://github.com/code-vaults/git-credential-broker/commit/80e697fe2183952f5612a7f29d2a6ba3830e489e), [`eee2074`](https://github.com/code-vaults/git-credential-broker/commit/eee207439cb643d1d0f49895609bb17f6bbda639), [`f596356`](https://github.com/code-vaults/git-credential-broker/commit/f596356b30413001c9dee30621b978cb2bd69e88)]:
  - gcb-core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [[`9ad2d26`](https://github.com/code-vaults/git-credential-broker/commit/9ad2d26139b8fd4e6875ce2279494f2b29ad8e0b), [`fdf3ff6`](https://github.com/code-vaults/git-credential-broker/commit/fdf3ff6779080573cd6fcae62e7b8156898352c2), [`51054d0`](https://github.com/code-vaults/git-credential-broker/commit/51054d0042306c6e14bf141e2fef0b53426c62af)]:
  - gcb-core@0.6.0

## 0.5.0

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

- [#72](https://github.com/code-vaults/git-credential-broker/pull/72) [`f542788`](https://github.com/code-vaults/git-credential-broker/commit/f5427886c2b684a1f94576be59d938929f94bdfb) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb doctor`: validate the configuration, print its SHA-256 digest, the active audit path when
  the daemon answers `ping`, the last `config` audit record, and the socket state.

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

- [#61](https://github.com/code-vaults/git-credential-broker/pull/61) [`165a95d`](https://github.com/code-vaults/git-credential-broker/commit/165a95d0f0d2b2ceac3222fc038d661373eb3375) Thanks [@JounQin](https://github.com/JounQin)! - Reload `broker.config.yml` without restarting: use a directory watch plus a 5-second safety poll,
  accept `SIGHUP`, keep the last good snapshot on a parse/validation failure, and swap providers
  atomically. The generated sidecar mounts the configuration directory at
  `/etc/git-cred-broker/config` and passes the matching `--config`; the key and refresh token stay
  outside that mount. `socketPath`, `socketMode` and `auditPath` still need a restart.

### Patch Changes

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

- [#46](https://github.com/code-vaults/git-credential-broker/pull/46) [`3475d35`](https://github.com/code-vaults/git-credential-broker/commit/3475d359849ed6ffd7f0c3fec07e5a8e99c1ab0b) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb config edit` to open the broker configuration in `$VISUAL`/`$EDITOR` and validate the
  saved file.

- [#60](https://github.com/code-vaults/git-credential-broker/pull/60) [`ceaf2be`](https://github.com/code-vaults/git-credential-broker/commit/ceaf2be9da7449fbd12800be02c4abbe5a42a382) Thanks [@JounQin](https://github.com/JounQin)! - Classify invalid-proxy pull-request refusals with the request op in the audit log, and stop counting an
  empty comment body as omitted lines in `pr --threads`.

- [#57](https://github.com/code-vaults/git-credential-broker/pull/57) [`28fa646`](https://github.com/code-vaults/git-credential-broker/commit/28fa64613db41314afc3512c6923630158d367a5) Thanks [@JounQin](https://github.com/JounQin)! - Fail loudly when `pr --threads` gets no review-thread report instead of printing nothing; a malformed,
  structurally incomplete, or missing-field GraphQL response is no longer reported as "no review
  threads". Refused pull-request actions are audited as `pull-request`, not `credential`.
- Updated dependencies [[`a7efb20`](https://github.com/code-vaults/git-credential-broker/commit/a7efb204e2fe75baf08f624e4f12951657961adf), [`c47a3a5`](https://github.com/code-vaults/git-credential-broker/commit/c47a3a5ea58593b8b1427571426db4e3316e1612), [`f4c8d71`](https://github.com/code-vaults/git-credential-broker/commit/f4c8d71679e8ca754c6f1fc870d64c61af13ea91)]:
  - gcb-core@0.1.0

## 0.0.3

### Patch Changes

- [#44](https://github.com/code-vaults/git-credential-broker/pull/44) [`c67103a`](https://github.com/code-vaults/git-credential-broker/commit/c67103a4c67f28197c7c79c8f9339b302281ac78) Thanks [@JounQin](https://github.com/JounQin)! - Add `gcb config check` to validate the broker configuration without starting the daemon.

- [#48](https://github.com/code-vaults/git-credential-broker/pull/48) [`728cad6`](https://github.com/code-vaults/git-credential-broker/commit/728cad6296cb19e9665fdeb9d0b7126cdfd5767f) Thanks [@JounQin](https://github.com/JounQin)! - Terminate a timed-out `gh` action with `SIGTERM` first, then `SIGKILL` after a two-second grace
  period. The group keeps being chased until a TERM-ignoring descendant is gone.
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
