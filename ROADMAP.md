# ROADMAP

This is the staged plan for the next version. `README.md` documents the tree as it exists today;
this file documents where it is going. The tree is at the last green baseline; the runtime changes
in this plan are not implemented yet.

## Locked decisions

- **Native Git stays native.** `commit` needs no broker; `push` uses the git credential helper.
  The broker does not proxy Git.
- **The container's Git remotes are HTTPS.** SSH remotes are rewritten to HTTPS in the agent
  container, which is what puts the credential helper on the push path. A host-side Git over SSH is
  outside this broker entirely.
- **Only `gh` for now.** `gcb gh …` is explicit; `gcb <token> …` is a `gh` subcommand shorthand when
  `<token>` is not a built-in command. `glab` is a later provider, not a current option.
- **Actions execute on the host.** The broker parses one allowed `gh` command, mints a token for that
  action, runs `gh` on the host, returns its output, and revokes the token. **No action token ever
  enters the container.**
- **Merge is not an agent action.** `pr:merge` is denied by default; a human merges. Action tokens
  therefore never carry `contents: write`.
- **The host broker stays.** (Working name for the current `host-opener` process.) App-authored PRs are skipped by some automated reviewers (CodeRabbit),
  so person-authored creation remains a first-class route.
- **Never create an object the acting identity cannot manage.** Before an issue or pull request is
  created, the broker verifies that the App is installed on the repository and that the action's
  permission covers both creation and later editing/closing. Otherwise it refuses before `gh` runs
  and points at `--as-user`. Creating an issue the App cannot close is not allowed.
- **No App permission auditing.** The check above is limited to the action's minimum permission and
  installation presence. The broker does not inspect or judge the App's full permission list.
  `diagnose` remains an operator tool, not a gate.
- **No ruleset checks, pre-push hook, or ref interception.** Branch policy is a human-configured
  GitHub ruleset, enforced server-side. The broker's branch settings are advisory for the dsh plugin,
  not a boundary.
- **Configuration becomes human-editable** (YAML, see Phase 1), with groups and globs. `yaml` is a
  dependency of the host package, not a bundled artifact.
- **Three packages, one command.** `gcb-cli` is the shared runtime; `gcb-client` and `gcb-host` are the
  installed entry points and both expose `gcb`. The container never installs host dependencies.
- **The dsh approval plugin lives in `../idsh`.** This repository only carries its roadmap item and
  the container-facing skill.
- **Tokens are minted per action and revoked in `finally`.** GitHub installation tokens have a fixed
  one-hour lifetime; a shorter expiry cannot be requested. Per-action execution timeouts are the
  configurable control.

## Brand and names (target)

The brand is **gcb**. One command, one service name:

- CLI: `gcb` (also the git credential helper);
- main app broker: `gcb app`, container/service `gcb`;
- host-side operation broker: `gcb host`, service `gcb-host` (currently `host-opener`);
- client commands: `gcb gh …`, and later `gcb glab …`.

The host broker is deliberately broader than "opener": it can grow to gh, glab, signing, and other
host operations. That breadth is allowed only through its typed operation table — it is not an
arbitrary host shell. The pairing to document is **app broker** (App identity, installation tokens)
versus **host broker** (host user identity, host CLIs).

Where each command runs:

- **agent container**: `gcb gh …` is the client; git uses the credential helper. `gcb gh` is not a
  host-side command.
- **host**: `gcb app` (app broker) and `gcb host` (host executor) are service commands. The human
  uses `gh` directly, with `gh auth switch` if they prefer; `gcb host` is not a CLI for them.
- `--as-user` is a request from the container client. The app broker validates it and forwards it to
  the host broker over a host-local channel; only the app broker's socket needs to be mounted into
  the container. The host broker never exposes a shell, only its typed operation table.

The repository may keep the `git-credential-broker` name; the package name `gcb` must be checked
against npm before publishing. If it is taken, use a scope rather than a second brand.

## Phase 0 — contracts (blocking)

No code until these are settled.

- [x] Write the design note for host-side `gh` execution, including the trust boundary and the
      differences from the current broker-side API implementation
      (`../notes/proposed/architecture/2026-10-25-host-side-gh.md`).
- [x] Decide the configuration format and the dependency strategy: YAML, `yaml`, no bundle; three
      workspace packages (see Phase 1).
- [x] Decide the host-user flag name: `--as-user <login>`; `--as-app` is the explicit default.
- [ ] Decide the final built-in command list and the `gcb <gh-subcommand>` shorthand.
- [x] Update `AGENTS.md` and `README.md` to point at this roadmap and state the current baseline.

**Done when:** the plan, the sample configuration, and the command table are reviewable without
reading code.

## Phase 1 — configuration

The configuration is the source of truth and must be comfortable to edit by hand.

- [x] Use YAML. `yaml` is the parser: `parseDocument` preserves comments and formatting, it is pure
      JavaScript, and the Document API is what lets `init` update one value without rewriting the file.
- [x] Split the repository into Yarn workspaces under `packages/`:
      - `gcb-cli`: shared argument parsing, help, protocol and types; no `yaml`;
      - `gcb-client`: container side; depends on `gcb-cli`; no host dependencies;
      - `gcb-host`: host side; depends on `gcb-cli` and `yaml`;
      - both client and host expose the same `gcb` bin; only one is installed per environment.
- [x] Do **not** bundle. npm installs dependencies; remove esbuild and the staged bundle build.
      `stage`, if kept, exports a commit and does not build a self-contained artifact.
- [x] Decide the global-install shape: `gcb` installed globally (`npm i -g` / `corepack`) is the
      only command skills and docs name. It must work from any checkout and from the container.
- [ ] Development mode: the globally installed `gcb` detects an explicit dev pointer (e.g.
      `GCB_DEV=1` plus `~/.config/gcb/dev.json`, written by `gcb dev use <checkout>`) and re-execs
      the development entry with the same argv. Production ignores the pointer. The dev path never
      changes the socket, token, or host paths unless the developer sets them.
- [ ] Define config v1:
      - top-level `version`;
      - hosts keyed by git host;
      - reusable named `groups` with `repos` globs, `actions` allow/deny, optional advisory
        `branches`, and per-action `timeouts`;
      - effective repos = union of host entries and selected groups; **deny always wins**;
      - owner/repo matching case-insensitive; branch matching case-sensitive; `*` one segment,
        `**` multiple segments;
      - unknown keys, unknown actions, unknown groups, malformed globs: refuse at load time.
- [ ] Config-defined actions and built-in overrides:
      - `[actions."<name>"]` declares `command`, optional `positional`, a `flags` whitelist, and
        `permissions`; the broker rebuilds a canonical argv from those values, never forwards raw
        argv and never uses a shell;
      - the built-in hard-deny list applies to configured actions too; unknown flags and undeclared
        positionals are refused;
      - configured permissions must be a subset of the host's `max_permissions` ceiling;
      - a built-in action may be overridden only to `enabled = false`, `deny = true`, or a narrower
        permission set. Changing its command, flags, or widening permissions is refused; add a new
        action name instead;
      - `gcb actions list|describe|check|discover` reports built-in and configured actions, validates
        them, and lists gh commands that are not yet covered without enabling them.
- [ ] Live reload (no restart):
      - watch the configuration **directory**, not a single file, with `fs.watch`; debounce
        200–500ms and re-add the watcher after rename/delete;
      - poll every 5 seconds (configurable) and compare mtime+size+content hash. SMB/NFS/9p and
        single-file bind mounts do not reliably deliver inotify events, so polling is the normal
        path on a NAS, not a crash fallback;
      - read the whole file, parse, validate, then atomically swap a frozen snapshot. Any parse or
        validation failure keeps the last good snapshot, logs and audits `config reload failed`,
        and leaves the service running;
      - `SIGHUP` forces a reload;
      - reload applies allowlists, groups, actions, timeouts and accounts. Provider/key changes
        rebuild the affected providers; in-flight requests keep the snapshot they started with;
        already-issued git tokens are not revoked and expire normally;
      - deployment mounts the config **directory** into a container, not the file, so a host-side
        atomic replace is visible;
      - `gcb doctor` reports the active config digest and the last reload result;
        `gcb config check` is the one-shot validation.
- [x] One-time migration: convert an existing `broker.config.json` to YAML before upgrade. The
      old `broker.config.json` filename is no longer discovered; an explicitly passed JSON file is
      still accepted because the YAML parser parses JSON. This phase adds no `config migrate` command.
- [ ] Add `gcb config check` and `gcb config edit` (`$EDITOR`, validated on save).
- [x] Update `init`, `compose`, `stage`, and `deployment.ts` to the chosen format.

Proposed YAML surface (subject to Phase 0 naming):

```yaml
version: 1

hosts:
  github.com:
    provider: github-app
    groups: [maintainer, reviewer]
    max_permissions:
      pull_requests: write
      contents: read
      issues: write
      checks: read
      statuses: read
      actions: read

groups:
  maintainer:
    repos: ["acme/*", "code-vaults/git-*"]
    actions: [pr:view, pr:create, pr:comment, pr:review]
    deny: [pr:merge]
    timeouts:
      default: 120
      "pr:create": 180
      "logs:read": 300
    branches:
      advisory_push: ["agent/*"]   # not enforced by the broker; the dsh plugin may use it
  reviewer:
    repos: ["upstream/*"]
    actions: [pr:view, pr:review, pr:comment]

actions:
  issue.close:
    command: [issue, close]
    positional: [number]
    flags:
      comment: string
    permissions:
      issues: write

host_broker:
  default: main
  accounts:
    main:
      config_dir: /home/operator/.config/gh
    agent:
      config_dir: /home/operator/.config/gh-agent
```

## Phase 2 — `gcb gh` core

- [ ] CLI dispatch:
      - built-ins first (`setup`, `init`, `stage`, `compose`, `probe`, `diagnose`, `authorize`,
        `app`, `host`, `config`, `version`, `help`);
      - `gcb gh …` explicit;
      - `gcb pr view …`, `gcb run view …` etc. resolve to the `gh` subcommand.
- [ ] Remove the built-in `pr` and `logs` commands. `gcb run view --job <id> --log` replaces `logs`.
- [ ] Build the command table. Every entry has:
      - canonical subcommand (no aliases, no abbreviations);
      - allowed flags and their types;
      - required fields;
      - action name and permission set;
      - whether host-user execution is possible.
- [ ] Rebuild the argv from parsed values; never forward the caller's argv.
- [ ] Deny rules evaluated before allow. Unknown command, unknown flag, or missing whitelist entry
      is refused.
- [ ] Built-in hard denies (not configurable on): `api`, `auth`, `extension`, `alias`, `config`,
      `secret`, `repo delete`, `release`, `gist`, `ssh-key`, `gpg-key`, `codespace`,
      `run download`, `workflow run`, `pr checkout`, `pr merge`; flags `--web`, `--hostname`,
      `--input`, `--template-file`, `--body-file` (the client converts a body file to `--body`).
- [ ] Resolve the repository:
      - from the container checkout's remotes, or an explicit `-R`;
      - the broker validates it against the effective allowlist and injects `--repo`;
      - `--hostname` is rejected; `GH_HOST` comes from the broker.
- [ ] Creation permission preflight (issues and pull requests):
      - resolve the App installation for the repository; if there is none, refuse **before** `gh`
        runs and name `--as-user`;
      - check the action's full permission set from the single action catalog: `pr:create` is
        `pull_requests: write` + `contents: read`; `issue:create` is `issues: write`;
      - the action catalog is the one source for the preflight, token mint, command table and the
        table below; a test asserts they do not drift;
      - this is a minimum-permission check, not an audit of the App's full grant list;
      - record the refusal in the audit log. Never create an object the acting identity cannot
        manage.
- [ ] Host execution:
      - run `gh` from a temporary `HOME` and `GH_CONFIG_DIR`;
      - minimal environment: `PATH`, proxy variables, `GH_TOKEN`, `GH_HOST`, `NO_COLOR`;
      - no shell, no `--body-file` host reads;
      - capture stdout/stderr with a hard cap;
      - per-action total timeout, `SIGTERM` then `SIGKILL`, kill the process group;
      - no automatic retry. A timed-out write reports that it may have completed.
- [ ] Token lifecycle:
      - mint per action with only that action's permissions;
      - never cache;
      - `finally`-revoke on success, failure, and timeout;
      - if revoke fails, log host-side and report that the token expires on its own.
- [ ] Single-source action catalog (table below): one declarative table drives the permission
      preflight, token mint, command table and docs; configured actions extend it under the Phase 1
      rules. A test rejects drift between catalog, preflight, mint and docs, and rejects any built-in
      override that widens a permission. The command→permission mapping is curated because `gh`
      exposes no machine-readable source for it, so review and tests replace a second hand-maintained
      list.
- [ ] Action permissions (initial table):

  | Action | Command | Permissions |
  |---|---|---|
  | `pr:view` | `gh pr view` | `pull_requests: read`, `contents: read`, `checks: read`, `statuses: read` |
  | `pr:list` | `gh pr list` | `pull_requests: read` |
  | `pr:diff` | `gh pr diff` | `pull_requests: read`, `contents: read` |
  | `pr:create` | `gh pr create` | `pull_requests: write`, `contents: read` |
  | `pr:comment` | `gh pr comment` | `pull_requests: write` |
  | `pr:review` | `gh pr review` | `pull_requests: write` |
  | `issue:create` | `gh issue create` | `issues: write` |
  | `run:view` | `gh run view` | `actions: read` |
  | `run:list` | `gh run list` | `actions: read` |

  Add rows only with the GitHub endpoint documentation for that command in the commit or note.
- [ ] Audit: action, repo, command, permissions, duration, exit status, truncated flag, fingerprint.
      Never output contents, never a token.
- [ ] Error boundary: provider response bodies stay in the host log; only broker-composed errors
      cross the socket. A failed `gh` returns a bounded, sanitized reason.
- [ ] Rename `host-opener` to `gcb host` and keep the person-authored route; wire it to the new flag in Phase 3.

**Done when:** `gcb gh pr view`, `pr create`, `pr comment`, `pr review`, and `run view --log` work
end to end with a fake `gh`, the token is revoked in every path, and injection/unknown-flag tests
fail closed.

## Phase 3 — host-user delegation and multiple host accounts

Naming: `--via-host` describes where it runs, not who acts. Recommended replacement:
**`--as-user <login>`**, with `--as-app` as the explicit default. Alternatives considered:
`--host-user`, `--author`, `--delegate`, `--as-human`. `--as-user` covers create, review, and issue
creation and leaves room for a login.

Deployment: keep the host broker on the **host**, as a host process, not in a container.

- It exists to use the host's `gh` binary and the host user's `gh` configuration. A container would
  need both copied or mounted, which duplicates the person's credentials into another place and
  makes the exposure larger, not smaller.
- Manage it with a systemd user unit (`Restart=always`) where user services exist, or a DSM boot-up
  task where they do not. `examples/host-opener.service` and `examples/host-opener-boot.sh` (to be renamed) already
  cover the two shapes; the boot task is what makes it survive a NAS restart.
- The broker container's `restart` policy does not cover the host broker; its own unit/task is
  its restart policy. That is deliberate: the two processes have different credentials and
  different failure domains.
- Run it as the user who owns the checkouts and the gh config, with host paths for `--root`.
- Do not containerise it later without a concrete reason; if that changes, the design note must say
  where the gh credentials live and why that is not a copy.

Account selection:

- `GH_CONFIG_DIR` is gh's config directory, unrelated to an SSH `Host` alias / `IdentityFile`
  setup. SSH identities affect Git over SSH; `gh` uses HTTPS API credentials from `hosts.yml`.
- `gh` keeps multiple accounts in one `hosts.yml` but only one is active; `gh auth switch` changes
  the active account. For the human at the keyboard that remains the right tool. It is global mutable
  state and races concurrent requests, so the host broker must not use it.
- Create one directory per account and log in once in each:

  ```sh
  GH_CONFIG_DIR="$HOME/.config/gh-main"   gh auth login
  GH_CONFIG_DIR="$HOME/.config/gh-agent"  gh auth login
  ```

  The host broker sets `GH_CONFIG_DIR` from the request's `--as-user`; no switch, no shared state. The
  same pattern is what a host-side independent agent should use, so it becomes a skill rather than
  only a host broker detail.
- `gh pr create` prompts to push or fork only when it has to infer the head from a local branch.
  The host broker runs from a temporary directory, so the canonical command always passes `--head`
  (resolved by the client from the checkout, or required as a flag), `--title` and `--body`;
  with those, gh never prompts. There is no head-state preflight: the host broker does not compare
  local and remote SHAs, check ancestry, classify freshness, or map a failure to a push flow. A PR
  tracks its head branch; a later push updates it, so any snapshot taken before the call would be
  stale. GitHub decides whether the head exists. A failure returns a sanitized
  `pr-create-failed`; the agent or skill may decide to push and retry. `review` and `issue create`
  do not push, so the SSH `Host` aliases are not used. If a future operation needs Git over SSH, it
  must use the checkout's own SSH configuration.

  **Why there is no freshness preflight, even though the first view can omit local commits.**
  `gh pr create` creates from the remote head branch. If the remote branch is stale, the initial PR
  reflects that stale head and omits local commits. This is accepted on purpose:

  - a PR tracks its head branch, not a fixed commit; a later `git push` updates the PR, so the
    omission is visible and recoverable rather than permanent;
  - the preflight cannot be atomic. GitHub's create call takes a branch name, not a head SHA, so a
    check followed by a create still races with another push; pinning the head would require a
    different API (or a Git proxy) that does not exist here;
  - the host broker has no local commit graph, and a client-computed ancestry result is untrusted and
    stale by the time gh runs; adding it would create false confidence;
  - the action token carries `pull_requests: write` plus `contents: read`, and no `contents: write`.
    A stale PR is a workflow mistake, not a privilege escalation; the PR and its checks make it
    visible.

  A hard guarantee would require a Git proxy or a post-create verification that blocks/closes a
  mismatched PR. Both are deliberately out of scope for this phase; if the omission must be
  impossible, that is the design to revisit.

- [ ] `gcb gh pr create --as-user agent …` requests the host broker instead of the app broker.
- [ ] Canonicalize `pr create` with `--repo`, `--head`, `--title` and `--body`; never invoke
      it in a way that can prompt. No head-state preflight: no local/remote SHA, no ancestry, no
      freshness classification.
- [ ] Keep one client-facing socket: the app broker forwards `--as-user` requests to the
      host broker over a host-local channel. The host broker's socket is not mounted into the agent
      container.
- [ ] `--as-user` is valid only on commands the host broker supports; elsewhere it is refused.
- [ ] The host broker supports multiple accounts:
      - per-account `GH_CONFIG_DIR` (shown in Phase 1), **not** `gh auth switch`;
      - `gh auth switch` is global mutable state and races concurrent requests;
      - a request names the account; the host broker refuses an unknown account and lists the configured
        ones.
- [ ] Extend host broker operations beyond `pr create`:
      - `pr review` (approve / request changes / comment);
      - `issue create`;
      - `pr comment` if the per-user identity matters.
      Each operation is a typed request with a host-side command table, canonical argv, repo
      binding, and no shell.
- [ ] Repositories without the GitHub App:
      - `--as-user` works because it uses the host user's own credentials, subject to the same
        allowlist;
      - an App action on an uninstalled repository returns a clear error that names `--as-user`;
      - never silently fall back from App to person.
- [ ] Audit the host-user action with `as_user`, repo, operation, and outcome; never the token.
- [ ] Concurrency: the host broker serves one request per account at a time only if the underlying `gh`
      state requires it; per-account config directories make parallel accounts safe.
- [ ] `pr create` head handling:
      - no raw gh prompt: canonical args include `--head`, `--title` and `--body`; no preflight.
      - GitHub decides whether the head exists. The broker does not compare SHAs, check ancestry,
        classify freshness, or map a failure to `head-not-pushed`.
      - a failure returns a sanitized `pr-create-failed`, with the provider detail on the host log.
      - `pr create` never pushes, forks, or asks for push/fork; a later `git push` updates the PR.
      - tests: failure returns `pr-create-failed`; no SHA inputs are required; the broker never
        pushes or forks.

**Done when:** a PR created with `--as-user agent` is authored by that account, a review and an issue
also work, concurrent requests for two accounts do not interfere, an uninstalled repo gets an
actionable error, and a failed `pr create` returns `pr-create-failed` without a push/fork side effect.

## Phase 4 — dsh integration and skills (owned by `../idsh`)

- [ ] File the issue/roadmap item in `../idsh`; do not implement the plugin here.
- [ ] Plugin (working name `@idsh/git-guard`) on the host side:
      - listen to `tools/pre-execute`;
      - parse `bash`/shell calls for `git` intent; if parsing is ambiguous, fail closed to `ask`;
      - classify: `git push` (force, delete, protected branch), `reset --hard`, `clean -fdx`,
        `branch -D`, `tag -d`, history rewrites;
      - return `{ kind: 'ask', reason, displayReason }`, which the registry resolves through
        `ctx.approval` (one-shot `allowed-once`, `reject`, `cancelled`, `unavailable`);
      - `reason` names the operation, repository/branch, the permission needed, and the risk;
      - configuration for branch globs and command classes; advisory only, not a server-side
        boundary.
- [ ] Container-facing skills, one directory per skill under `.agents/skills/<name>/SKILL.md`:
      - `gcb-gh`: what is allowed, what is denied, the shorthand, body-file behaviour;
      - `gcb-host-user`: `--as-user`, when to use it, what it means for authorship;
      - `gcb-git`: credential helper boundaries (no branch enforcement), when to ask a human.
- [ ] Host-side skill (may live in `../idsh` or the host dotfiles): `gh-multi-account`:
      - one `GH_CONFIG_DIR` per account, `gh auth login` once in each;
      - `GH_CONFIG_DIR=… gh …` for non-interactive use;
      - `gh auth switch` only for an interactive single-user shell, with a lock if shared;
      - how to list accounts (`gh auth status` in each directory) and how to rotate one.
- [ ] Keep `AGENTS.md` current: every phase updates the rules, the layout table, and the skill list.

## Phase 5 — operations and hardening

- [ ] `gcb doctor`: config validity, `gh` version/path, host broker liveness, account selection,
      socket permissions; no ruleset or App-permission audit.
- [ ] Audit rotation and a documented retention policy; rate/size limits for `gcb gh`.
- [ ] Timeout and output-cap defaults validated against a slow proxy; document how to raise them.
- [ ] Remove or make opt-in the old App-permission pre-flight (`verifyAppPermissions`) on the
      runtime path. `diagnose` may still report what the App sees.
- [ ] Commit signing without a private key in the container (non-blocking; low priority):
      - `git commit -S` needs a signer, and the key must not be copied into the agent container;
      - options: forward the host's `gpg-agent` extra socket, forward an SSH agent for
        `gpg.format=ssh`, or add a narrow host-side signing request to the host broker;
      - whichever is chosen, document that any process able to reach the signing socket can request
        signatures, and that the key itself never leaves the host;
      - decide later; it does not block the action or credential work.
- [ ] Deferred, not planned:
      - ruleset/bypass verification (needs `administration: read`);
      - pre-push hook;
      - Git proxy for ref-level enforcement;
      - `glab`/GitLab provider.

## Handoff rules

- The roadmap is the source of truth for order. Do not implement a later phase to unblock an earlier
  one without updating this file.
- Every completed item gets a test or a recorded manual verification. A phase is done only when
  `corepack yarn check` passes and the docs match.
- Every phase updates `AGENTS.md`, `README.md` (if user-facing), and the `.agents/skills/` entries it
  changes.
- Decisions that reverse a locked decision above require a new design note under `.agents/notes/`
  and an update here, not a silent code change.
