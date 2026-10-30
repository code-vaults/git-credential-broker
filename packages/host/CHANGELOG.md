# gcb-host

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
