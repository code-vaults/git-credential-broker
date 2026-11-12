# gcb

Short-lived, single-repository git credentials for a container, from a broker on the host that holds
the only long-lived secret. The GitHub App private key never enters the container, and `git push`
still works.

> **Roadmap:** YAML configuration, the three-package split and the `gcb gh` broker/client path are
> implemented; the host image with `gh` is available. Live reload is implemented; host-user delegation is planned.
> [`ROADMAP.md`](ROADMAP.md) is the target; this README documents the current tree.

Two commands are installed:

- **`gcb`** — the credential helper git calls, and the CLI that sets everything up
- **`gcb daemon`** — the broker (a host process, or a Docker sidecar)

## How it works

```
┌─ HOST ──────────────────────────────────────────────────────────────────────┐
│  broker.config.yml   allowlist, paths                                      │
│  app.pem              the only long-lived secret: 0600, outside every mount  │
│  audit.jsonl          append-only, unreadable from the container             │
│                                                                             │
│  gcb daemon                                                      │
│    · signs an RS256 app JWT with the private key                             │
│    · resolves owner → installation, mints ONE repository, narrowed           │
│      permissions, one hour                                                   │
│    · caches it, and default-denies everything else                           │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ unix socket (broker uid == container uid)
┌───────────────────────────────────▼─ CONTAINER ─────────────────────────────┐
│  gcb                                                       │
│    get           → ask the broker, print the credential                      │
│    store, erase  → no-ops; nothing is ever persisted                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Platforms

The broker is designed for a POSIX host — a Linux machine, or a Linux container, which is what Docker
Desktop runs. Two things are specific to that, and neither is a line of code that can simply be
fixed:

- **The transport is a unix domain socket**, and unix sockets do not cross the Windows/Linux
  boundary. A native Windows `git` cannot reach a Linux broker: run the helper on the broker's side
  (WSL, or a container), or keep the pairing within one of them. Inside WSL that means the socket
  directory belongs on the distribution's own filesystem (`~`), not under `/mnt/c`: a Windows-backed
  path (9p/drvfs) cannot carry a unix socket, and the same applies to bind-mounting a Windows
  directory into a Linux container.
- **Its access control is file permissions** — `0700` on the socket directory, `0660` on the socket,
  with the broker and the client sharing a uid. Windows emulates modes without an ACL effect, so
  those calls would enforce nothing there.

The requirement that matters is a shared **local** filesystem, not merely "runs in a container": the
socket is a filesystem object, so the broker and the git that uses it must be on the same machine,
or — when both are containers — share a volume. A socket cannot be reached over a network share, and
that is the point: there is no listening port to authenticate and no traffic to send through a proxy.

**Native Windows is refused, not half-supported.** There the socket would be a named pipe and the
mode bits would enforce nothing, so a broker that started would look healthy while every local process
could ask it for credentials. `gcb daemon`, `setup` and `compose` exit with that
explanation — the three commands whose result is specific to the machine running them. `--help` still
works.

**WSL works**, because it is Linux. One trap: the socket directory belongs on the distribution's own
filesystem (`~/git-broker`), never under `/mnt/c` — a Windows-backed 9p/drvfs mount cannot carry a
unix socket, and the broker checks for that before it binds.

CI runs the suite on Linux and inside WSL, and checks both refusals on native Windows
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Install

There are two installed packages, because the container and the host need different dependencies.
Both provide the same `gcb` command; install one per environment.

```sh
# container (client)
npm install -g gcb-client

# host (broker and administration)
npm install -g gcb-host
```

`gcb-client` has no runtime dependencies. `gcb-host` depends on `yaml`; npm installs it there. Do not
install both globally on the same machine: they race for the same `gcb` bin. Run `setup` from the
installed client; one-off execution is not a supported installation shape.

Or run from a checkout. Node 24 strips TypeScript types, but the workspaces still need their
dependencies:

```sh
git clone https://github.com/code-vaults/git-credential-broker /opt/gcb
cd /opt/gcb && corepack yarn install
node --conditions=development packages/client/bin/gcb.js --help
node --conditions=development packages/host/bin/gcb.js --help
```

That explicit `node --conditions=development ...` form is the source-development path: no global
install is needed. The `bin/gcb.js` entry is only a shim; the condition selects each package's
`development` export (`src/index.ts`), so the implementation that runs is TypeScript.
Keep the checkout outside every container mount.

## GitHub actions

The action path is wired through the broker; the host image must include `gh` before these commands
can run. The container never receives the token. Build the image, then pass `--image code-vaults/gcb-host:dev` to
the compose command in [Quick start](#quick-start-sidecar):

```sh
docker build --target host -t code-vaults/gcb-host:dev .
```

The image's `CMD` starts `gcb daemon`; the rendered command runs that installed binary and keeps the
`sh -c` wrapper that applies `GCB_PROXY`. See [DEVELOPMENT.md](DEVELOPMENT.md#use-your-build).

Debian packages use the Aliyun mirror by default in this image; pass
`--build-arg APT_MIRROR=<host>` to build against another mirror.

The image installs `gh` from GitHub's stable apt repository; the version comparison and why the
Debian package is not used are recorded in
[the image note](.agents/notes/verified/environment/2026-10-26-gh-image.md).

```sh
gcb gh pr view 12 --repo owner/name
gcb gh pr create -R owner/name --head feat/x --title "A title" --body "A body"
gcb gh run view 123456 --log --repo owner/name
gcb gh discussion create -R owner/name --category "Q&A" --title "A question" --body "Details"
gcb gh discussion list -R owner/name --state all --limit 10
gcb gh discussion view 12 -R owner/name --comments
```

`-R` is the short form of `--repo`, as in `gh` itself. The `gh discussion` commands require
GitHub CLI 2.94.0 or newer and remain a preview command in gh. `discussion view --comments` cannot
be combined with `--json`, `--after` needs `--comments`, `--jq` and `--template` need `--json`, and the
catalog does not expose `--web`.

`gcb pr <subcommand>`, `gcb run <subcommand>`, `gcb issue <subcommand>` and
`gcb discussion <subcommand>` are shorthands for the same actions when the catalog has one —
`gcb pr view 12`, `gcb pr close 12`, `gcb run list`,
`gcb issue create --repo owner/name --title "A title" --body "A body"`,
`gcb discussion create --category "Q&A" --title "A question" --body "Details"`.
Catalogued actions dispatch through `GCB_PRIMARY` (default `gh`; an unsupported name fails closed).
The flag-only `gcb pr` form
described below is still what runs the lifecycle `gh` cannot express (opening as a person, review
threads); `gcb pr --close` is not accepted; use `gcb pr close <number>` (or `gcb gh pr close`).

For that flag-only form, creation uses the app's installation token by default; `--as-user` without
a value uses the broker's authorized user token for open, review, reply, resolve, edit, comment and
catalogued actions including issue and discussion creation, and `--as-user <login>` uses the host
broker for creation, review, reply and edit. Resolving a review
thread defaults to the user identity because the pull-request token this broker mints is narrowed to
`pull_requests: write` and `contents: read`, while `resolveReviewThread` needs
`contents: write` — a grant the broker gives only to the credential git pushes with, never to a
pull-request token.

`gcb push` pushes the current branch from the host, not from this container. Plain `git push` is not
intercepted; use `gcb push` when the host must perform the push. The host broker runs
`git push` with its own gh account and rebuilds the target URL from the allowlisted repository; no
token or remote URL from the container is used. It requires a host broker and a checkout on the
host. The destination must be allowlisted, or be a verified fork whose parent/source is
allowlisted when `allowForkPush` is on; host push checks the source relationship, not the fork's own
allowlist entry. It defaults to `origin` and the current branch and takes `gcb push [<remote> [<branch>]]`; `--force`
is an explicit overwrite and `--force-with-lease` only overwrites if the remote branch still matches the local
remote-tracking ref (there is no arbitrary push-argument pass-through). `--as-user=<login>`
selects `~/.config/gh-<login>` on the host; the host reads the selected remote's protocol only to
choose `https` or `ssh`, and the repository URL is still rebuilt from the allowlist. SSH uses the
host's SSH config (key, port and proxy); `sshAccounts` maps a login to its host alias instead of
falling back to the default key. `gcb push` runs the container's own `pre-push` hook before
writing the request; the host never runs container-owned hooks. The hook's remote OID is the local
remote-tracking ref (zeros when the branch was never fetched), not the value the remote advertises
during a real push.

`gcb push` authorizes the **destination**, not the source. The commit comes from the host checkout,
which the container can write, so a container can send an allowlisted repository and push a commit
made in another checkout; the host cannot prove checkout provenance without a host-owned clone.
Commit signatures can establish who signed the commit object, not which checkout produced it. That is
the same boundary as ordinary `git push`, and the allowlist should be read as "this destination may
be written", not "this source produced the commit". Use a host-owned clone when checkout provenance
matters, and signed commits when the signer matters.

`gcb repo fork [owner/name]` creates a fork under a person's account. An app cannot own a fork, so
`--as-user` is required: bare uses the broker's authorized user, a login uses the host broker. Without
a repository it forks the checkout's `origin`. `--host` selects the host; otherwise the origin remote's host is
used when available, and `github.com` is the fallback.

Inside a checkout, `--repo` can be omitted only when `origin` names a usable GitHub repository whose
host matches `--host`; otherwise pass `--repo`, or the matching `--host`.

`--jq` is evaluated inside gh, so the app route keeps the token in the isolated gh config instead of
the environment. If a proxy URL carries a username or password, `--jq` is refused because the
expression could read `HTTPS_PROXY`; drop it and filter the JSON locally (`--json` selects fields
where the action has that flag). The host broker route (`--as-user <login>`) refuses `--jq`
entirely, because its gh program inherits the selected host account environment; use `--json` or
drop `--jq` there too.

The exact command, flags and required values come from
[`packages/core/src/actions.ts`](packages/core/src/actions.ts); `gcb gh --help` renders that catalog.

## Set up the GitHub App first

1. **Settings → Developer settings → GitHub Apps → New GitHub App.**
2. Permissions: **Contents: Read and write**, plus **Pull requests: Read and write** if the agent
   should open pull requests, **Actions: Read** for `logs`, and **Checks: Read** / **Statuses: Read** /
   **Issues: Read and write** for the corresponding `gcb gh` actions. Grant them in the app, not only
   in the request. The per-action source of truth is the catalog in
   [`packages/core/src/actions.ts`](packages/core/src/actions.ts).
3. Install the app on the account that owns the repositories, granting access to those alone.
4. Download the **private key**; note the **App ID** and **Client ID**.
5. Ignore the client secret — this tool never uses it. Installation tokens are obtained by signing a
   JWT with the private key; the client secret belongs to OAuth user-to-server flows.

## Quick start: sidecar

Docker only. Run `init` and `compose` from an installed `gcb-host`. The default sidecar uses the
released `gcb-host` image and runs its installed `gcb daemon`; `--code` runs a staged commit instead.

```sh
DEPLOY=/srv/git-cred-broker        # the deployment directory
SOCKET_DIR=/srv/git-broker-socket  # a host directory the pushing container already mounts
PUSHER_UID=1000                    # uid of the container that will use the socket
PUSHER_GID=1000                    # gid of that container

gcb init --mode sidecar --dir "$DEPLOY" \
  --cert ~/Downloads/app.private-key.pem \
  --allow owner/repo --client-id Iv23li… --app-id 123456

gcb compose --dir "$DEPLOY" --socket-dir "$SOCKET_DIR" \
  --user "$PUSHER_UID:$PUSHER_GID" > "$DEPLOY/docker-compose.yml"
cd "$DEPLOY" && docker compose up -d
```

`--user` must be the uid:gid of the container that will use the socket; the socket is mode 0660 and
created by that identity. A sidecar running as a different user cannot connect. If the pusher runs
as the same user as the sidecar, the default is correct.

`init` writes the configuration and key as the invoking user, with the key mode 0600. If
`authorize` has run, it also writes `user.refresh` beside the key, mode 0600 and **read-write**:
the broker rotates that token on every exchange. It creates the `user.refresh.lock` directory beside
the token, mode 0700, also read-write. The sidecar's user must read the config, key and
`user.refresh`, write `user.refresh.lock`, and write `log/` (including an existing audit file). If
`PUSHER_UID` differs from the user running `init`/`authorize`, either run both as that uid or `chown`
the config, key, `user.refresh`, `user.refresh.lock`, the log directory and its audit file to it;
re-run the `chown` after `authorize` creates the token and lock. Keep the key and `user.refresh` at
0600 and the lock directory at 0700; do not make them world-readable.

A deployment directory holds the config, key, log and compose file; `app/` is only a convention
for a staged commit, and `--code` accepts any directory outside every mount.

```text
$DEPLOY/
  broker.config.yml
  app.pem
  log/
  docker-compose.yml
  app/                 optional staged commit
```

Nothing above has to name the shared directories. A host process asks the container runtime — docker,
podman or nerdctl, whichever is there — for the host paths its containers bind-mount, running or
stopped; a process inside the container reads `/proc/self/mountinfo`. When neither can answer — no
runtime, a runtime that knows of no container at all, or a host whose only runtime is plain
`containerd`, which has no interface this knows — `init`, `stage` and `authorize` refuse rather than
guess. The runtime route is deliberately a superset: a directory bind-mounted into _any_ container
counts as shared, because any container that can rewrite the broker's code is as good a reason not to
stage there as the agent is.

The sidecar runs the installed `gcb` from the released host image. To pin a reviewed commit instead, run `gcb stage --to "$DEPLOY/app"`, install its dependencies in that directory with
`corepack yarn install`, and pass `--code "$DEPLOY/app"` to `compose`. Run `stage` from the repository
root you intend to export, or pass `--repo <path>`: it defaults to the current directory and exports
that repository's `HEAD`, never the working tree. `stage` is export-only: it does not install
dependencies or build, and it never runs the commit's code. It leaves `STAGED.json` beside the code
recording the commit; `--code` does not require that file, and the directory may have any name outside
the mounts.

## Quick start: host process

Use this when the host has Node 24 or newer.

```sh
cd /srv/git-cred-broker

gcb init \
  --cert ~/Downloads/app.private-key.pem \
  --allow owner/repo --client-id Iv23li… --app-id 123456

gcb daemon --check    # validates the config and the key, binds nothing
gcb daemon            # run it under systemd, or a scheduled task
```

Run it as the user that owns the deployment directory: it must read `app.pem` and write the socket
directory and the audit log.

## Point the container's git at the broker

```sh
export GIT_BROKER_SOCKET=/run/git-broker/broker.sock
export GIT_BROKER_REQUIRE=1        # fail closed instead of falling back to another helper
gcb setup
```

`setup` records `credential.helper = !gcb` (PATH-resolved, so the same config works for a global
install and a dev shim) and `credential.useHttpPath` (without the latter, git sends no repository
path and the broker can only authorize host-wide). The helper is resolved by the git process later,
not by `setup`: that process must have `gcb` on its PATH. Run setup from the installed client, not
a one-off execution.

It also rewrites `git@github.com:` remotes to
https **inside the container only** so the host's SSH workflow is untouched, and writes a CA bundle
when the image has none. In compose:

```yaml
environment:
  - GIT_BROKER_SOCKET=/run/git-broker/broker.sock
  - GIT_BROKER_REQUIRE=1
volumes:
  - /srv/git-broker-socket:/run/git-broker
```

## Everyday changes

```sh
gcb init --allow owner/another-repo         # add a repository
gcb init --remove-allow owner/old-repo      # remove one
gcb init --replace-allow --allow a/one,b/two
gcb init --permissions contents=write,pull_requests=write
gcb init --cert ~/Downloads/new-key.pem     # rotate the key
```

No `--cert`, `--client-id` or `--app-id` is needed once the file exists: `init` changes only what you
pass, prints the before/after allowlist, and leaves hand edits alone. Restart the broker afterwards.

Moving between deployments rewrites the recorded paths in place, keeping the allowlist:

```sh
gcb init --mode host --socket-path /run/git-cred-broker/broker.sock
```

`--socket-path` is required when moving to host mode, because the socket on file belongs to the
sidecar. Commands find the configuration by convention — `--config`, else `$GIT_BROKER_CONFIG`, else
`./broker.config.yml` — so run them from the deployment directory.

## Check it without pushing

```sh
gcb probe --host github.com --repo owner/repo
gcb config check --config /srv/git-cred-broker/broker.config.yml
gcb config edit --config /srv/git-cred-broker/broker.config.yml
gcb config allow add github.com owner/repo --config /srv/git-cred-broker/broker.config.yml
gcb config allow remove github.com owner/repo --config /srv/git-cred-broker/broker.config.yml
gcb doctor --config /srv/git-cred-broker/broker.config.yml
gcb diagnose --config /srv/git-cred-broker/broker.config.yml
```

`probe` prints the broker's decision with the credential reduced to a fingerprint, so its output is
safe to share: exit `0` allowed, `1` denied, `3` broker unreachable. `probe` talks to the socket, so
it runs wherever the pusher runs.

`config check` is host-side and reads only the configuration file: it validates it and prints the
deployment mode and hosts without starting the broker or reading the key. `config edit` opens the
existing file in `$VISUAL`/`$EDITOR` (it does not create a missing one; run `init` first) and
validates it after the editor exits. `config allow add|remove <host> <owner/name>` changes one
exact allowlist entry (no glob, URL, wildcard or `.git`), preserving comments and the rest of the
document, keeps its LF or CRLF line endings (mixed endings are refused), validates the result, and
replaces the file atomically. The output says the reload is unconfirmed: the running daemon watches
the config directory, but the command does not signal it, and `socketPath`/`socketMode`/`auditPath`
still need a restart. The line also carries `entry=… reload=unconfirmed signal=unavailable`.
`config edit` edits the existing file in place and needs write access to the file; some editors also
write swap or backup files beside it, so their directory may need write access too. `config allow`
takes a target-keyed lock beside the config to serialize allow updates; a lock left by a crash is
not removed automatically, so the command fails with the lock path and an operator removes it once
no gcb command is running. Do not run `config edit` concurrently with a `config allow` update; the
edit is a manual full-file write and does not take that lock.

`doctor` is host-side and read-only: it validates the config, prints its SHA-256 digest, asks the
running daemon for its active audit path (labelling it active or configured), the last `config` audit
record, the socket state (socket, missing, symlink or another file), the `gh` on PATH and the host
broker's status file.

`diagnose` asks GitHub what the app can actually see — the only reliable way to tell "repository
does not exist" from "not selected for this installation", which GitHub reports identically. It reads the
app's **private key**, so run it where the key is. On a host-process deployment that is the host; for
a sidecar it is inside the container:

```sh
DEPLOY=/srv/git-cred-broker
cd "$DEPLOY" && docker compose exec gcb gcb \
  diagnose --config /etc/git-cred-broker/config/broker.config.yml
```

### Reading a CI log

`logs` fetches one workflow job's log through the broker. It needs `actions: read` on the app and
nothing else: the broker mints a short-lived token narrowed to that permission, reads the log, and
returns only the text, so no credential reaches this side. The job id is the check run id:

```sh
gcb logs --host github.com --repo owner/repo --job 1234567890
```

It talks to the socket, so it runs wherever `probe` runs. Off the container there is neither
`GIT_BROKER_SOCKET` nor a socket file, so pass the socket explicitly — and give the CLI an absolute
path, because a relative one is resolved against the current directory, which is not always the
checkout:

```sh
node --conditions=development /srv/git-cred-broker/packages/client/bin/gcb.js logs \
  --socket /srv/git-cred-broker/broker.sock \
  --host github.com --repo owner/repo --job 1234567890
```

### Opening a pull request

`pr` opens one through the broker, the same way `logs` reads one: it mints a token narrowed to
`pull_requests: write` plus read access to the branches it names, posts the request itself, and
prints the number and the URL. No credential reaches this side, so the agent can propose a change
without being able to push to the branch it targets.

```sh
gcb pr --host github.com --repo owner/repo \
  --head feature --base main --title "a title" --body-file pr.md
  # say it about one line rather than about the pull request
  # --number 7 --comment --file Dockerfile --line 4 --side right --body "why this marker exists"
  # read its review threads, answer one, or change a comment you wrote
  # --number 7 --threads
  # --number 7 --reply-to 123456 --body "good point"
  # --edit 123456 --body "corrected: it is the other branch"
  # from your fork into an upstream: a remote name instead of a repository typed by hand
  gcb pr --repo code-vaults/repo --head origin:feature --base upstream:main --title "a title" \
    --body-file pr.md
```

Both the app and the installation need `pull_requests: write`; without it the error names the
permission instead of failing at GitHub. `--draft` opens it as a draft. `--threads` prints the ids of
a pull request's review threads and their comments; `--reply-to` adds a reply inside one (add bare
`--as-user` to attribute it to the broker's authorized person), and `--edit` replaces the body of one
of those review comments; bare `--as-user` works for `--reply-to`, `--edit` and `--comment` too. The
comment id names the comment — and its pull request — so `--edit` takes no `--number`. GitHub lets
only an author change a comment, so without `--as-user` the app can change only the comments it
authored; with bare `--as-user` it changes the authorized person's.

### Person actions: pull requests, issues and reviews

There are two ways to have a pull request or issue authored by a person, and they stay alternatives:
the **host broker** below needs no long-lived secret anywhere and costs a process you keep running;
**`authorize`** needs no second process, at the cost of a token as wide as your own access to GitHub.

A pull request opened through the broker by default is authored by the app, and automated reviewers
are entitled to skip those. To have one authored by you, either use the
broker's authorized user token with `--as-user` (after `gcb authorize`), or run the host broker on the
host, beside the same checkout, and ask for it with `--as-user <login>` from the container:

```sh
# on the host, once — it serves every checkout below $HOME
gcb host          # --root <dir> to narrow it, repeatable
gcb host status                            # JSON: config, cwd, version and pid from ~/.gcb-host/status.json
# for repo fork, reviews, review replies, pull request edit, issue edit/comment or an explicit
# --repo, also pass --config <broker.config.yml> so its allowlist applies; reviews always carry a
# repo, even from origin
# or, at boot and for good: examples/gcb-host-boot.sh (see below)
```

**Copy that file outside the mounts before a task runs it.** It runs as you, so leaving it in the
checkout would let anything that can write the checkout decide what your credentials do at boot.

```sh
# in the container
gcb pr --as-user octocat --repo owner/repo --head feature --base main \
  --title "a title" --body-file pr.md

# reply as that host account
gcb pr --as-user octocat --number 94 --reply-to 123456 --body "good point"

# submit a review or edit a pull request as the broker's authorized person, or a host account
gcb pr --as-user --number 94 --approve
gcb pr --as-user octocat --number 94 --approve
gcb pr --as-user --number 94 --title "new title"
gcb pr --as-user octocat --number 94 --body-file pr.md
gcb pr --as-user octocat --number 94 --request-changes --body "please fix"
gcb pr --as-user octocat --number 94 --review-comment --body "a note"

# edit or comment on an issue as a person
gcb issue edit 94 --as-user --title "new title"
gcb issue comment 94 --as-user --body "a note"
```

The host broker creates pull requests, submits reviews, replies to review comments, edits pull
requests, runs catalogued actions and forks with the gh account named by the request; catalogued
actions include issue create/edit/comment/close/reopen and pull request close/reopen. It has no
merge action. For `repo fork`, review replies, reviews, pull request edit, issue edit/comment and any
request that names `--repo` explicitly — every review always carries its repository, even when
derived from origin — it checks the repository against the broker config's allowlist (pass
`--config`), except a `readOnly` action with `allowPublicRead`, or a catalogued action on the parent of an allowlisted fork with `allowFork` (see the configuration table). An
explicit `--repo` needs no checkout of that repository; without one, a checkout must exist. When
there is no checkout at all, the client and host broker use the shared
`~/.gcb-host/channel` instead of `.git/gcb/host-broker`; the request must carry `--repo`, and the
host broker must run in its normal root-serving mode (not `--repo <checkout>`). Create it once with:

```sh
install -d -m 700 ~/.gcb-host/channel
```

Both sides must see the same path and be able to write it (in practice the same uid, as with
socketMode 0660); the container can write that channel, so anything able to write it can
submit requests as the selected account within the allowlist.
`--as-user <login>`
selects `~/.config/gh-<login>` on the host, matching the login exactly including case; create that
directory once with `GH_CONFIG_DIR="$HOME/.config/gh-octocat" gh auth login`. The directory must
already exist, and inherited `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`/`GH_HOST` are ignored
for that request. Any existing account directory can be named, so this is a selector rather than a
gate. A request with no `--as-user` uses the broker route and does not select the host broker's login.
The host broker never runs a shell, and
the program it calls is configuration rather than a hard-coded `gh`: `--command /path/to/gh`, or
`$GCB_HOST_COMMAND`. It cannot push or merge; catalogued actions such as pull request close
run through `gcb gh --as-user <login>` under the same allowlist. `GCB_HOST_TIMEOUT_MS` changes only the client's wait for the host broker; the request stays in the
channel and the host broker may still answer. It exists for tests and debugging, not as a policy knob.

`--root` may be repeated and defaults to `$HOME`; checkouts within `--depth` levels of a root
(4 by default) are served with no further setup, including ones created later, which the next sweep
picks up. The bound exists because the walk repeats every `--interval` seconds; raise `--depth` for
deeper layouts. To start it once and keep it,
`examples/gcb-host.service` is a systemd user unit; on a system without user services,
`examples/gcb-host-boot.sh` is the same thing for a DSM boot-up task — absolute paths, one
instance at a time, and its output in a log file. Without `--as-user`, catalogued actions use the
broker route as the app; bare `--as-user` selects the broker's authorized person for actions that
declare `appUser`; `--as-user <login>` writes a request for this host broker. With a login and no
host broker running they fail; they do not fall back to the broker route.

```sh
# in the container: the broker's authorized person
gcb issue create --as-user --repo owner/repo --title "An issue title" --body-file issue.md
# or the host broker, using its gh-<login> account
gcb issue create --as-user octocat --repo owner/repo --title "An issue title" --body-file issue.md
```

A pull request opened with the app's installation token is authored by the app, and automated
reviewers are entitled to skip those. Use `gcb authorize` below: it stores the person OAuth token, and
the broker uses that token for person-authored pull requests.

#### Authorizing as a person instead

Two things the app needs: its **client id** in the configuration (the App ID will not do), and
**Enable Device Flow** selected in its settings, and **Expire user authorization tokens** left on — the
broker renews with the refresh token, and GitHub only issues one while that is selected. No client secret: the device flow does not use one,
so no second long-lived secret joins the key.

Authorizing the app once is how the broker acts as a person, because GitHub issues the token for the
app _and_ the person together. Run this on the host:

```sh
gcb authorize --config /srv/git-cred-broker/broker.config.yml
```

It prints a code and asks you to open <https://github.com/login/device>, then waits. Type the code on
whatever device has a browser. The refresh token is stored beside the private key, which is where the
broker looks for it, and the broker renews it from then on — nothing else needs running.

When the configuration and key are mounted into the broker container, run `authorize` on the **host**,
in the deployment directory:

```sh
gcb authorize --broker-container --config /srv/git-cred-broker/broker.config.yml
```

This writes `/srv/git-cred-broker/user.refresh`, which the sidecar mount maps to the broker's
`/etc/git-cred-broker/user.refresh`. The flag acknowledges that the host directory is a
broker-container bind mount; it must not also be mounted into the agent container. The command checks
that the target is writable before starting the device flow.

The target's parent directories are a deployment trust boundary: they must be controlled by the
operator and not writable by an untrusted local process. gcb opens the token before the device flow
and validates the descriptor (regular file, owner, mode); a parent replacement can deny or misplace
the write, but cannot make the 0600 token readable to another uid.

Compose adds the writable `user.refresh` and `user.refresh.lock` mounts when the token exists at
render time; it creates the lock directory. Create an empty `user.refresh` (mode `0600`) as the host
user who will run `authorize`, before running `gcb compose`; an empty file is treated as absent.
If the sidecar uid differs, `chown` the token and lock directory to the sidecar uid after
`authorize`, so the broker can read and rotate them. If Compose was rendered while the file was
absent, rerender and recreate the sidecar after authorization so the mounts are added. A sidecar
created before the lock directory existed also needs a rerender and recreate. When the sidecar runs as the same uid, re-authorize while it keeps running: `gcb authorize` takes
the shared `user.refresh.lock` directory for its replacement, and the broker takes the same lock
around read → exchange → write. If the sidecar uid differs, either run `authorize` as that uid (the
live path) or stop the sidecar, chown the token/lock directory, and restart it. The identity running `authorize` must be able to read
`broker.config.yml` and own `user.refresh` and `user.refresh.lock`, so chown those back (or run
`authorize` as the sidecar uid); changing only `user.refresh` is not enough. The key is not read by
`authorize` and can stay with the sidecar uid. After re-authorization as the sidecar uid, no restart is needed; the broker re-reads the token on
its next renewal.

These ownership steps belong to the host/deployment operator. An agent inside the container
cannot chown host files; container-initiated re-authorization needs a typed idsh/deployment operation
that performs the ownership handover around the device flow.

The user token is used where the person identity is required or preferred: authoring a pull request,
submitting a review, resolving a review thread (GraphQL refuses that for an app), replying to or
editing a review comment, and creating an issue through the broker action path.

The token and its `user.refresh.lock` directory need to be **writable by the broker**, unlike the
key: GitHub rotates the refresh token on every exchange, so mount both read-write
(`./user.refresh:/etc/git-cred-broker/user.refresh:rw` and
`./user.refresh.lock:/etc/git-cred-broker/user.refresh.lock:rw` in the sidecar). A read-only mount works until the first renewal, which is the worst moment to find out.

The allowlist says what this channel **may be used for**, not what the app is installed on: an entry for a
repository the app was never installed on is meaningful, because `authorize` and the host broker act as a
person, who needs no permission there at all — that is how a pull request from your fork to an upstream
works. It matters more for those two routes than for the app, not less: a person's token reaches
everything that person reaches.

#### Set up a proxy

If this host reaches GitHub through a proxy, the process needs two things: the usual variables, and
`NODE_USE_ENV_PROXY=1`. Node's own `fetch` reads `http_proxy` / `https_proxy` only when that
variable is set, and it arrived in Node 24 — which is why the floor moved there.

```sh
http_proxy=http://proxy.example:7890
https_proxy=http://proxy.example:7890
no_proxy=localhost,127.0.0.1
NODE_USE_ENV_PROXY=1
```

For a sidecar, pass them in its `environment:` (compose only forwards what the file names); for the host
process, `EnvironmentFile=` in the unit and the boot wrapper, both of which already read
`/etc/git-cred-broker/proxy.env` if it exists.

The sidecar also reads `GCB_PROXY` at `docker compose up` time, without re-rendering the compose
file: a URL pins that proxy, an empty value goes direct, and leaving it unset keeps the host variables.

Every broker command also accepts a per-command choice:

```sh
gcb gh pr view 7 --no-proxy
gcb pr checks 7 --proxy http://proxy.example:7890
```

For `git push`, the credential helper has no per-command argument, so it reads
`GCB_PROXY=<url>` or `GCB_PROXY=` (empty, direct) from git's environment. That controls how the
broker mints the token; Git's own HTTP transport still uses `http.proxy` / `HTTPS_PROXY` /
`NO_PROXY`, so set both when the push itself must follow the same route.

`gh` receives the choice through its process environment; the broker builds a separate
`node-fetch-native` instance for each proxy value and caches it, so commands sharing a choice reuse the
same connection pool. `--as-user` carries the same choice to the host broker, which applies it to its
own `gh pr create`.

The choice comes from the pushing container, so it can override a host proxy policy. A deployment that
must force all egress through one route should not give `gcb-client` to a container it does not trust;
the allowlist and the broker key still bound what that container can reach, not which network path it
uses. The `--as-user` host broker honours the same choice while acting as the person, and the person's
token is not bounded by the app key, so only serve checkouts from a container you trust.

The broker, `authorize` and `diagnose` **refuse to start** when a proxy variable is set and `NODE_USE_ENV_PROXY` is
not `1`, instead of reaching GitHub directly by a route nobody chose. `gh`, which the host broker runs,
reads those variables itself (it is Go), so it only needs them to arrive.

#### Keeping it running

On a host with user services, `examples/gcb-host.service` is a unit for it:

```sh
npm i -g gcb-host                     # the unit calls the installed CLI
cp examples/gcb-host.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gcb-host
loginctl enable-linger "$USER"                          # so it survives logout and starts at boot
journalctl --user -u gcb-host -f                     # its output
```

`loginctl enable-linger` is the part that is easy to miss: without it a user service stops when
your last session ends and does not come back at boot. `Restart=always` is already in the unit, so
a crash is a ten-second gap rather than a silent stop.

On a host without user services — a Synology NAS, for instance — `examples/gcb-host-boot.sh` is
the same thing for a boot-time task: absolute paths, one instance at a time, its output in a log
file.

## Configuration reference

The daemon watches the configuration directory with `fs.watch` for low latency and also runs a 5-second digest poll as a safety net; if the native watcher is unavailable, polling runs alone. A valid change is applied without restarting, and an invalid one keeps the last good snapshot. Send `SIGHUP` to force a reload after fixing a file. `socketPath`, `socketMode`, `auditPath`, `auditMaxBytes` and `auditKeep` require a restart.

The broker only reads this file. It is YAML. The loader discovers `broker.config.yml` by default;
the old `broker.config.json` name is no longer discovered, so rename or convert an existing
deployment, or pass `--config broker.config.json` explicitly (the YAML parser accepts JSON). TOML is
not read.

The file normally contains no secrets, but it may: `privateKeyPem` and `static.password` are accepted
inline. When either is used, treat the file as secret material — mode 0600, outside every container
mount.

Top level:

| Key                     | Default      | Meaning                                                                           |
| ----------------------- | ------------ | --------------------------------------------------------------------------------- |
| `socketPath`            | — (required) | Absolute path of the unix socket the broker binds.                                |
| `socketMode`            | `432` (0660) | Socket permissions, in decimal. `0660` is right when broker uid == container uid. |
| `auditPath`             | `null`       | Append-only JSONL. Keep it outside the container's mounts.                        |
| `auditMaxBytes`         | `10485760`   | Rotate the active audit file before a write would exceed this size.               |
| `auditKeep`             | `5`          | Number of rotated audit files to retain.                                          |
| `actions`               | —            | Per-action policy, keyed by catalogued action; `{ deny: true }` disables it.      |
| `actionRateLimit`       | —            | Maximum catalogued actions per host in a rolling minute; omitted disables it.     |
| `tokenCacheSkewSeconds` | `300`        | Re-mint a cached credential this long before it expires.                          |

Per host, keyed exactly as git reports it (`github.com`, or `host:port` for other ports):

| Key               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`        | `github-app` or `static`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `allow`           | Default-deny list: `owner/repo`, or a whole-segment wildcard `owner/*`. Malformed entries (no slash, three segments, a partial wildcard like `wid*`) are rejected at load time rather than silently matching nothing.                                                                                                                                                                                                                                                                               |
| `allowPublicRead` | Default `false`. Let explicit `readOnly` actions run on a repository verified public without an allowlist entry, on both the app and host routes. The app identity uses a metadata-only token and requires the App to be installed with metadata read. Bare `--as-user` uses the authorized person token; `--as-user <login>` uses the host account token. Both may have private access; an exhausted 403/429 is reported as a rate limit, a plain 403 as a refusal, never as a private repository. |
| `allowForkPush`   | Default `false`. Allow a **public** fork whose parent/source is an allowlisted repository. For `gcb push`, the host verifies the relation and uses the host account/SSH key; the App need not be installed on the fork. For the app credential path, the App must be installed with `contents: write`.                                                                                                                                                                                              |
| `sshAccounts`     | Optional map from gh login to an SSH host alias for `gcb push`, e.g. `{ "example-user": "github-example-user" }`. SSH aliases keep their own key/port/proxy settings; a login without an entry is refused rather than falling back to the default key.                                                                                                                                                                                                                                              |
| `actions`         | Optional per-host action policy, e.g. `{ "pr:close": { "deny": true } }`. A global top-level `actions` deny still wins.                                                                                                                                                                                                                                                                                                                                                                             |
| `allowFork`       | Default `false`. Allow a **catalogued action** (`gcb gh …`, `gcb issue …`) on the public parent/source of an allowlisted **public** fork, after GitHub confirms the relationship. Wildcard entries are not used for inference. It does not cover the lifecycle `gcb pr create` path; that still needs the target repository in `allow`.                                                                                                                                                             |

`github-app`: `clientId` (preferred `iss`), `appId` (fallback), `privateKeyPath` or `privateKeyPem`,
`permissions`, `apiBaseUrl` (GitHub Enterprise, must be HTTPS), `apiVersion`, `installationCacheSeconds`,
`verifyAppPermissions` (default `true`). `permissions` must be a subset of what the app was actually
granted; the broker checks once per process and names any missing permission.

`static`: `username`, `password`, `passwordPath` or `passwordEnv`, `expiresInSeconds`.

`hosts` is validated strictly — a known provider, a non-empty allowlist, and no two host keys that
differ only by case — so a typo cannot sit there looking like configuration while doing nothing.
Only top-level `_comment*` keys are ignored.

## Troubleshooting

| Symptom                                                                    | Cause and fix                                                                                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cannot reach the broker at <path>: ENOENT`                                | The broker is not running, or `GIT_BROKER_SOCKET` is wrong. Start it; check the socket file exists.                                                       |
| `... exists only inside the sidecar container`                             | The config suits the other deployment. `init --mode sidecar` or `--mode host`.                                                                            |
| `denied [repo-not-allowed]`                                                | Not in the allowlist: `init --allow owner/repo`.                                                                                                          |
| `denied [protocol-not-https]`                                              | The remote is `http`; use an `https` remote. Plaintext is never served.                                                                                   |
| `refusing to replace <path>: something that is not a socket is in the way` | A leftover file sits on the socket path. Remove it and start again.                                                                                       |
| `'credential-node' is not a git command`                                   | The helper value is `node x.ts` without the `!` git needs: `git config --global credential.helper '!node /path/packages/client/bin/gcb.js'`.              |
| `could not mint a credential`                                              | Deliberately generic, because provider errors can embed API responses. `diagnose --config …` for the real reason.                                         |
| `server certificate verification failed. CAfile: none`                     | The image has no CA bundle. `setup` writes one; better, add `ca-certificates` to the image.                                                               |
| A host's HTTPS push suddenly asks for a password                           | The helper stays silent when unconfigured, so the next helper runs; it only refuses (`quit=1`) when `GIT_BROKER_SOCKET` is set or `GIT_BROKER_REQUIRE=1`. |

## Security notes

What it buys: the container holds no long-lived credential. Every `get` yields one repository's
installation token, an hour at most, cached; everything not allowlisted is refused; the audit log
records a fingerprint per decision, never the credential.

What it does not do: it is not a sandbox for the agent. An agent with push access can still push to
allowlisted repositories, and can rewrite anything in the mounted workspaces. Two consequences
matter:

- The broker must run **outside** the container — it holds the key.
- The **code** it runs must be outside every mount too, not just the key. The code has the key's
  privileges: it can mint tokens for anything the app can see, and read the key itself. If the agent
  can rewrite that code, the agent owns the allowlist. That is what `stage` is for.

With a shared `.git/config` between host and container: never set credentials with `git config
--local` (it is the same file on both sides); the container's own `~/.gitconfig` is private, but any
directory the container shares is not, which is why `setup` refuses to write the config through a
symlink or into one.

Credential helpers are only consulted for HTTP(S) remotes, so none of this affects the host's SSH
pushes.

The design record, the review that preceded it, and the measured environment facts are in
[`.agents/notes/`](.agents/notes/).

## Development

Building from a checkout, tests and releasing: [DEVELOPMENT.md](DEVELOPMENT.md). The rules that keep
this working, and the traps it already paid for, are in [AGENTS.md](AGENTS.md).

## Layout

```
packages/core/src/        shared parser, protocol, types, platform helpers and the gh action catalog
packages/client/src/     credential helper, setup, probe, logs, pr, gh
packages/host/src/       YAML config, providers, broker, daemon and host commands
packages/*/bin/          the two installed gcb bins (client and host)
test/                    unit tests, plus an end-to-end push over authenticated smart HTTP
examples/                configuration snippets
docker-compose.example.yml  tracked sidecar example
DEVELOPMENT.md           building from source, tests, releasing
.agents/notes/           the design, its review, and the measured environment facts
```

## Embedding the client in another image

The contract between the pushing container and the broker is deliberately small:

- the helper finds the socket through `GIT_BROKER_SOCKET`; otherwise `GIT_BROKER_SOCKET_FILE`,
  defaulting to `$HOME/.config/git-credential-broker/socket`;
- the broker's own egress uses `http_proxy` / `https_proxy` / `no_proxy` with
  `NODE_USE_ENV_PROXY=1`; the sidecar additionally reads `GCB_PROXY` at `docker compose up`
  time (`<url>` pins a proxy, empty is direct, unset keeps the host variables); every command that
  talks to GitHub accepts `--proxy` / `--no-proxy`;
- the socket is the only mounted interface; no credential, token or App key is ever placed in
  the pushing container.

`gcb --version` and `gcb gh --help` are the discovery checks inside a base image.

## Images

Two local dev images mirror the two packages; the release publishes the same repositories on GHCR:

| Image                        | Contents                              | Use                          |
| ---------------------------- | ------------------------------------- | ---------------------------- |
| `code-vaults/gcb-client:dev` | `gcb` client and Node runtime only    | idsh base / `COPY --from`    |
| `code-vaults/gcb-host:dev`   | broker, `gh`, and broker dependencies | run `gcb daemon` on the host |

The release publishes both repositories with `latest`, `<version>` and `sha-<sha>` tags. The
`:dev` tags are local build tags and are not published; do not pull them from GHCR.

For local development, build and reuse the `:dev` tags:

```sh
docker build --target client -t code-vaults/gcb-client:dev .
docker build --target host   -t code-vaults/gcb-host:dev .
```

While the image exists locally, Docker uses it instead of pulling from the registry. Another machine
or CI builds the same Dockerfile and tags, rather than pulling `:dev`.

For idsh's dev image, name the client image as a stage and copy only the gcb packages into the base:

```dockerfile
ARG BASE=devockr/idsh:base
ARG GCB_CLIENT_IMAGE=code-vaults/gcb-client:dev
FROM ${GCB_CLIENT_IMAGE} AS gcb-client
FROM ${BASE}

COPY --from=gcb-client /usr/local/lib/node_modules/gcb-core /usr/local/lib/node_modules/gcb-core
COPY --from=gcb-client /usr/local/lib/node_modules/gcb-client /usr/local/lib/node_modules/gcb-client
RUN ln -s /usr/local/lib/node_modules/gcb-client/bin/gcb.js /usr/local/bin/gcb
```

Copy the two package directories, not all of `/usr/local/lib/node_modules`: the idsh base already has
its own `corepack` and `npm`, and a whole-directory copy would replace them. That default is for a
local build; CI and production pass a published version instead, e.g.
`--build-arg GCB_CLIENT_IMAGE=ghcr.io/code-vaults/gcb-client:<version>`.

### Updating the sidecar

Pin a released `gcb-host` image by version or digest; do not use `:dev` or `pull_policy: never` for
updates. The generated service is named `gcb` by default (`gcb compose --name <name>` changes it).

The released image contains the `gcb` binary and starts `gcb daemon`. Keep the generated `sh -c`
wrapper: it applies `GCB_PROXY`, and its final `exec` already runs the installed binary. Do not replace
the whole `command` with a bare `gcb daemon` list.

```sh
docker compose pull gcb
docker compose up -d --no-deps --force-recreate gcb
```

Verify the running sidecar, not just the host CLI:

```sh
docker compose exec gcb gcb --version
docker compose exec gcb gcb doctor --config /etc/git-cred-broker/config/broker.config.yml
gcb --version   # in the pushing environment; must be the same release line
```

`gcb doctor` checks configuration, the audit path, `gh` and the host broker; it is not a probe of
the app daemon's socket liveness. Check
liveness from the pushing environment with `gcb probe --repo <owner/name>`: exit `0` means allowed,
`1` denied, and `3` means the broker is unreachable. Alert on a non-zero doctor result; restart only
when `probe` returns `3` or the socket is gone; a configuration error needs an operator.

Use the same release line on both sides. Typed host replies and the active-audit ping need at least
`0.3.0`; `gcb authorize --broker-container` needs host `0.8.0`.

## App permissions by action

The action catalog is the source for these requirements; `gcb gh --help` prints the same
actions. Grant them on the App, then approve any changed permissions on each installation.

<!-- action-permissions:start -->

| Action                               | App permissions                                                           |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `pr view`                            | `pull_requests: read`, `contents: read`, `checks: read`, `statuses: read` |
| `pr list`                            | `pull_requests: read`                                                     |
| `pr diff`                            | `pull_requests: read`, `contents: read`                                   |
| `pr create`                          | `pull_requests: write`, `contents: read`                                  |
| `pr edit`                            | `pull_requests: write`                                                    |
| `pr close`                           | `pull_requests: write`                                                    |
| `pr reopen`                          | `pull_requests: write`                                                    |
| `pr ready`                           | `pull_requests: write`                                                    |
| `pr lock`                            | `pull_requests: write`                                                    |
| `pr unlock`                          | `pull_requests: write`                                                    |
| `pr update-branch`                   | `pull_requests: write`, `contents: write`                                 |
| `pr revert`                          | `pull_requests: write`, `contents: write`                                 |
| `pr checks`                          | `pull_requests: read`, `checks: read`, `statuses: read`                   |
| `pr status`                          | `pull_requests: read`, `checks: read`, `statuses: read`                   |
| `pr comment`                         | `pull_requests: write`                                                    |
| `pr comment-edit`                    | `pull_requests: write`                                                    |
| `pr comment-delete`                  | `pull_requests: write`                                                    |
| `pr review`                          | `pull_requests: write`                                                    |
| `pr review-edit`                     | `pull_requests: write`                                                    |
| `pr review --id` (`pr:review-by-id`) | `pull_requests: read`                                                     |
| `discussion create`                  | `discussions: write`                                                      |
| `discussion edit`                    | `discussions: write`                                                      |
| `discussion list`                    | `discussions: read`                                                       |
| `discussion view`                    | `discussions: read`                                                       |
| `discussion comment`                 | `discussions: write`                                                      |
| `issue create`                       | `issues: write`                                                           |
| `issue edit`                         | `issues: write`                                                           |
| `issue comment`                      | `issues: write`                                                           |
| `issue comment-edit`                 | `issues: write`                                                           |
| `issue comment-delete`               | `issues: write`                                                           |
| `issue close`                        | `issues: write`                                                           |
| `issue reopen`                       | `issues: write`                                                           |
| `issue lock`                         | `issues: write`                                                           |
| `issue unlock`                       | `issues: write`                                                           |
| `issue pin`                          | `issues: write`                                                           |
| `issue unpin`                        | `issues: write`                                                           |
| `issue view`                         | `issues: read`                                                            |
| `issue list`                         | `issues: read`                                                            |
| `run view`                           | `actions: read`                                                           |
| `run list`                           | `actions: read`                                                           |
| `run watch`                          | `actions: read`, `checks: read`                                           |
| `run cancel`                         | `actions: write`                                                          |
| `run rerun`                          | `actions: write`                                                          |
| `release list`                       | `contents: read`                                                          |
| `release view`                       | `contents: read`                                                          |
| `workflow list`                      | `actions: read`                                                           |
| `workflow view`                      | `actions: read`, `contents: read`                                         |
| `label list`                         | `issues: read`                                                            |
| `label create`                       | `issues: write`                                                           |
| `label edit`                         | `issues: write`                                                           |
| `label delete`                       | `issues: write`                                                           |
| `search issues`                      | `issues: read`                                                            |
| `search prs`                         | `pull_requests: read`                                                     |

<!-- action-permissions:end -->

`pr revert` needs `gh` 2.83.0 or newer; older stock `gh` binaries do not have that subcommand.

`pr status` with `--repo` reports the app identity's relevant pull requests and review requests
with their checks; gh's current-branch section is absent because the broker has no branch.

A missing `checks` or `statuses` grant is why `gcb pr view 72` can fail while `pr diff` works:
`pr view` reads the checks and statuses endpoints as well. Raising a permission on the App is not
enough by itself — the installation must approve the updated grant.
