# Host-side `gh`, one action at a time

- **Date:** 2026-10-25
- **Status:** proposed; the Phase 2 design required by ROADMAP.md
- **Context:** the app broker already runs on the host and holds the App private key. The container
  has a credential helper and a unix socket, but no host `gh` binary, no `gh` credentials, and no
  action token.

## Decision

The app broker executes an allowed `gh` action on the host, for the duration of that action:

```text
container gcb gh pr view
  └─ typed action + fields ── unix socket ──> app broker
                                             ├─ validate against the action catalog
                                             ├─ resolve/validate the repository
                                             ├─ mint one installation token
                                             ├─ run gh with a canonical argv
                                             └─ revoke the token in finally
  <── bounded stdout/stderr ─────────────────┘
```

The container never receives `GH_TOKEN`, never runs `gh`, and never sends an argv the broker will
execute.

## Why the app broker, not the container

`gh` is only useful with a token and a host config. Putting either in the container would undo the
credential boundary the git helper exists to keep. The app broker already runs outside the mounts
and already mints narrow installation tokens, so it is the smallest place that can run an action
without copying a secret inward.

This is separate from the host broker (`host-opener`, later `gcb host`). The host broker exists for
actions that must run as a **person** (`--as-user`); it uses the host user's `gh` configuration and is
never mounted into the container. The app broker may forward a validated `--as-user` request to it
over a host-local channel, but the container still sees only one socket.

## The trust boundary

The container controls a request, not a command line.

- It names an **action** (`pr:view`, `pr:create`, ...) and typed values.
- The broker looks the action up in one catalog and rebuilds a canonical argv from accepted values.
- Unknown actions, unknown flags, missing required fields, and values past their limit are refused
  before a token is minted or `gh` is started.
- The broker injects `--repo` after validating it against the effective allowlist. It never trusts
  a caller-supplied hostname; `GH_HOST` comes from the broker.
- There is no shell, no `eval`, no pass-through of `--body-file`, `--web`, `--hostname`, `--template`, or
  `--input`. A body file is read by the client and sent as `--body`.
- `gh` runs with a temporary `HOME`/`GH_CONFIG_DIR`, a minimal environment, a hard output cap and a
  per-action timeout. A timed-out write may have completed, and the result says so.

## The catalog is the single source

One declarative table owns, per action:

- the canonical `gh` subcommand;
- accepted flags and their types;
- required positionals;
- the full permission set;
- whether host-user execution is possible;
- the default timeout.

The token mint, the creation preflight, the command table and the docs all read that table. A test
fails if the token request and the action's permission set disagree, or if a built-in override widens
a permission. The table is curated because `gh` exposes no machine-readable command-to-permission
mapping; review and tests are what keep it honest.

## Creation preflight

For `pr:create` and `issue:create`, the broker resolves the App installation for the repository and
checks the action's minimum permissions **before** running `gh`. If the App is not installed, it
refuses and names `--as-user`; it never silently falls back to the person. This is a
minimum-permission check, not an audit of the App's full grant list.

## Audit and errors

An audit record names the action, repository, command, permissions, duration, exit status,
truncation, and token fingerprint. It never includes stdout/stderr contents or the token.

Only broker-composed errors cross the socket. A failed `gh` returns a bounded, sanitized reason such
as `pr-create-failed`; provider output stays in the host log. The deliberate exception remains a
`ProviderConfigError` composed only from configuration and a permission name.

## Hard denies

The built-in deny list in ROADMAP.md is not configurable on. Deny is evaluated before allow, and it
applies to configured actions too. `pr:merge` is denied by default; the broker is not a merge tool.
The action token therefore never needs `contents: write`.

## What this does not do

- It does not proxy Git; `git push` stays on the credential helper.
- It does not run an arbitrary host shell, or forward raw `gh` arguments.
- It does not use `gh auth switch`; the app broker uses installation tokens, and the host broker
  uses one `GH_CONFIG_DIR` per account.
- It does not check rulesets or install a pre-push hook; branch policy is server-side.

## Rollout

1. Add the catalog and the parser/canonical-argv builder, with tests; no execution yet.
2. Add the typed socket request and the broker-side host executor behind the catalog.
3. Move `pr view`, `pr create`, `pr comment`, `pr review`, and `run view --log` onto `gcb gh`.
4. Add `--as-user` forwarding to the host broker.
5. Remove the old built-in `pr`/`logs` commands after the new path is green.
