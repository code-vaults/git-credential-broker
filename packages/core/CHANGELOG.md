# gcb-core

## 0.8.1

No changes in this release.

## 0.8.0

### Minor Changes

- [#124](https://github.com/code-vaults/git-credential-broker/pull/124) [`9ae646c`](https://github.com/code-vaults/git-credential-broker/commit/9ae646c2df2d6c9fc0f8b4e73e1e597e8cba9063) Thanks [@JounQin](https://github.com/JounQin)! - Add repo-scoped search actions: `search:issues` (`issues: read`) and `search:prs`
  (`pull_requests: read`). The broker still injects `--repo`, and rejects `repo:` / `org:` / `user:` qualifiers in the query, so a search cannot escape the allowlist.

- [#129](https://github.com/code-vaults/git-credential-broker/pull/129) [`5d93ad4`](https://github.com/code-vaults/git-credential-broker/commit/5d93ad4f05d54150afd66bcb2b531e70a38c86a8) Thanks [@JounQin](https://github.com/JounQin)! - Add the `pr:revert` catalog action (`gh pr revert <number>`) with optional title, body and draft flags. It requires `pull_requests: write` and `contents: write`.

- [#127](https://github.com/code-vaults/git-credential-broker/pull/127) [`d311cb0`](https://github.com/code-vaults/git-credential-broker/commit/d311cb09b88766f3fce6f7877d6da81d205526a0) Thanks [@JounQin](https://github.com/JounQin)! - Search actions accept multiple positional terms (or one quoted phrase): the final positional is
  repeatable, and each term is passed to `gh` as its own argument after `--`. Repository-scope
  qualifier rejection applies to every term.

## 0.7.1

No changes in this release.

## 0.7.0

### Minor Changes

- [#117](https://github.com/code-vaults/git-credential-broker/pull/117) [`d247ec5`](https://github.com/code-vaults/git-credential-broker/commit/d247ec5cdd624e1c45376f887ae25405bdbeb1c9) Thanks [@JounQin](https://github.com/JounQin)! - Add the label domain to the catalog: `label:list` (issues read) and `label:create`/`label:edit`/
  `label:delete` (issues write). Deleting requires `--yes`, so the host broker never waits for an
  interactive prompt.

- [#114](https://github.com/code-vaults/git-credential-broker/pull/114) [`b83dd51`](https://github.com/code-vaults/git-credential-broker/commit/b83dd51e012f7566202b5d31c8dca7a9580087e5) Thanks [@i1stG](https://github.com/i1stG)! - Add read-only release and workflow actions to the catalog: `release:list`, `release:view`,
  `workflow:list`, and `workflow:view`, with their GitHub permissions, flags and tests.

- [#116](https://github.com/code-vaults/git-credential-broker/pull/116) [`70eff30`](https://github.com/code-vaults/git-credential-broker/commit/70eff304474522fba9b0383d90918bbe9470abdb) Thanks [@JounQin](https://github.com/JounQin)! - Add `issue:comment-delete` (`issues: write`) and `pr:comment-delete`
  (`pull_requests: write`), which DELETE one issue/PR conversation comment through the same fixed
  gh api endpoint as the edit actions.

- [#119](https://github.com/code-vaults/git-credential-broker/pull/119) [`80e697f`](https://github.com/code-vaults/git-credential-broker/commit/80e697fe2183952f5612a7f29d2a6ba3830e489e) Thanks [@JounQin](https://github.com/JounQin)! - Record the resolved config path, working directory and package version in a fixed host-private
  `~/.gcb-host/status.json` (not beside a config and not in the container-writable channel marker), and
  add `gcb host status` (JSON, no options, no config argument). The status file is written at daemon startup
  with `config: null`, updated after a successful config load, is read/written with
  `readJson`/`writeJsonAtomic`, and is never read from the caller's cwd.

- [#115](https://github.com/code-vaults/git-credential-broker/pull/115) [`eee2074`](https://github.com/code-vaults/git-credential-broker/commit/eee207439cb643d1d0f49895609bb17f6bbda639) Thanks [@i1stG](https://github.com/i1stG)! - Add `issue:comment-edit` (`issues: write`) and `pr:comment-edit` (`pull_requests: write`), which
  PATCH one issue/PR conversation comment through a fixed gh api endpoint. The body travels in an
  `--input` JSON file, never in argv. `pr:comment` also gains the person route, matching
  `issue:comment`.

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

## 0.6.0

### Minor Changes

- [#102](https://github.com/code-vaults/git-credential-broker/pull/102) [`9ad2d26`](https://github.com/code-vaults/git-credential-broker/commit/9ad2d26139b8fd4e6875ce2279494f2b29ad8e0b) Thanks [@JounQin](https://github.com/JounQin)! - Add the `allowPublicRead` and `allowForkPush` host opt-ins. Catalog entries can now declare
  `readOnly: true`; with `allowPublicRead`, such an action can run on a repository verified public
  without an allowlist entry.

  The app identity uses a metadata-only installation token; the App must be installed on the
  repository, and the request is refused rather than falling back to anonymous when it is not, because
  `gh` needs authentication. Bare `--as-user` uses the authorized person token, and
  `--as-user <login>` uses the host account token. The host route performs the same fresh public check
  before running the action.

  Visibility is checked freshly for each request, not cached, bounded at 10 seconds and refused on a
  redirect. The check shares GitHub's 60/hour IP quota; an exhausted 403/429 is reported as a rate
  limit, a plain 403 as a refusal, and neither as a private repository. Person tokens may themselves
  have private access; those forms rely on the visibility check rather than a token scope. A
  configured `apiBaseUrl` must now be an HTTPS URL.

  `allowForkPush` lets a git credential request through for a **public** fork whose GitHub
  parent/source is allowlisted, still limited to the credential path; catalog actions keep the normal
  allowlist. Its unauthenticated fork check uses the same deadline and redirect refusal. It needs the
  App installed on the fork owner, because the credential still comes from an installation token; a
  plain contributor fork without that installation cannot mint one.

- [#101](https://github.com/code-vaults/git-credential-broker/pull/101) [`fdf3ff6`](https://github.com/code-vaults/git-credential-broker/commit/fdf3ff6779080573cd6fcae62e7b8156898352c2) Thanks [@JounQin](https://github.com/JounQin)! - Add `run:watch` to the action catalog. It polls a workflow run until it finishes, with optional
  `--compact`, `--exit-status` and `--interval`. The timeout is 3300 seconds, five minutes below the
  one-hour installation-token lifetime, so a poll cannot outlive the token. It uses `actions: read` and
  `checks: read` (for annotations) and sets `appUser`.

- [#99](https://github.com/code-vaults/git-credential-broker/pull/99) [`51054d0`](https://github.com/code-vaults/git-credential-broker/commit/51054d0042306c6e14bf141e2fef0b53426c62af) Thanks [@JounQin](https://github.com/JounQin)! - Add `pr:update-branch` to the action catalog. It takes an optional `--rebase`, uses
  `pull_requests: write` and `contents: write`, and sets `appUser`, so bare `--as-user` works through
  the app broker. `appUser` follows `pr:edit`: updating a branch is an author operation, while
  close/reopen/ready/lock stay host-account only. Bare `--as-user` needs a user token with
  `contents: write`; the recommended `Contents: Read` token is enough for PR editing but not for
  updating a branch. The default app route and `--as-user <login>` do not depend on that token. For a
  PR whose head is a fork, the app installation token is scoped to the base repository and cannot
  write the head fork; use `--as-user <login>` for that case.

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
