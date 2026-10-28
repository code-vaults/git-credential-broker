# gcb

Short-lived, single-repository git credentials for a container, from a broker on the host that holds
the only long-lived secret. The GitHub App private key never enters the container, and `git push`
still works.

> **Roadmap:** YAML configuration, the three-package split and the `gcb gh` broker/client path are
> implemented; the host image with `gh` is available. Host-user delegation and live reload are planned.
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
installed client; one-off `npx` execution is not a supported installation shape.

Or run from a checkout. Node 24 strips TypeScript types, but the workspaces still need their
dependencies:

```sh
git clone https://github.com/code-vaults/git-credential-broker /opt/gcb
cd /opt/gcb && corepack yarn install
node --conditions=gcb-development packages/client/bin/gcb.js --help
node --conditions=gcb-development packages/host/bin/gcb.js --help
```

Keep the checkout outside every container mount.

## GitHub actions

The action path is wired through the broker; the host image must include `gh` before these commands
can run. The container never receives the token. Build the image, then pass `--image code-vaults/gcb-host:dev` to
the compose command in [Quick start](#quick-start-sidecar):

```sh
docker build --target host -t code-vaults/gcb-host:dev .
```

Debian packages use the Aliyun mirror by default in this image; pass
`--build-arg APT_MIRROR=<host>` to build against another mirror.

The image installs `gh` from GitHub's stable apt repository; the version comparison and why the
Debian package is not used are recorded in
[the image note](.agents/notes/verified/environment/2026-10-26-gh-image.md).

```sh
gcb gh pr view 12 --repo owner/name
gcb gh pr create -R owner/name --head feat/x --title "A title" --body "A body"
gcb gh run view 123456 --log --repo owner/name
```

`-R` is the short form of `--repo`, as in `gh` itself.

`gcb pr <subcommand>` and `gcb run <subcommand>` are shorthands for the same actions when the
catalog has one — `gcb pr view 12`, `gcb pr close 12`, `gcb run list`. The flag-only `gcb pr` form
described below is still what runs the lifecycle `gh` cannot express (opening as a person, review
threads); `gcb pr --close` is gone and refuses with a pointer at `gcb gh pr close`.

Inside a checkout, `--repo` can be omitted only when `origin` names a usable GitHub repository whose
host matches `--host`; otherwise pass `--repo`, or the matching `--host`.

The exact command, flags and required values come from
[`packages/cli/src/actions.ts`](packages/cli/src/actions.ts); `gcb gh --help` renders that catalog.

## Set up the GitHub App first

1. **Settings → Developer settings → GitHub Apps → New GitHub App.**
2. Permissions: **Contents: Read and write**, plus **Pull requests: Read and write** if the agent
   should open pull requests, **Actions: Read** for `logs`, and **Checks: Read** / **Statuses: Read** /
   **Issues: Read and write** for the corresponding `gcb gh` actions. Grant them in the app, not only
   in the request. The per-action source of truth is the catalog in
   [`packages/cli/src/actions.ts`](packages/cli/src/actions.ts).
3. Install the app on the account that owns the repositories, granting access to those alone.
4. Download the **private key**; note the **App ID** and **Client ID**.
5. Ignore the client secret — this tool never uses it. Installation tokens are obtained by signing a
   JWT with the private key; the client secret belongs to OAuth user-to-server flows.

## Quick start: sidecar

Docker only. Run `init` and `compose` from an installed `gcb-host`. The image is stock `node:24-slim`;
the default sidecar fetches `gcb-host` with `npx` at start, while `--code` runs a staged commit with no
registry access at boot.

```sh
DEPLOY=/srv/git-cred-broker        # broker.config.yml, app.pem and log/ live here
SOCKET_DIR=/srv/git-broker-socket  # a host directory the pushing container already mounts

gcb init --mode sidecar --dir "$DEPLOY" \
  --cert ~/Downloads/app.private-key.pem \
  --allow owner/repo --client-id Iv23li… --app-id 123456

gcb compose --dir "$DEPLOY" --socket-dir "$SOCKET_DIR" \
  > "$DEPLOY/docker-compose.broker.yml"
docker compose -f "$DEPLOY/docker-compose.broker.yml" up -d
```

Nothing above has to name the shared directories. A host process asks the container runtime — docker,
podman or nerdctl, whichever is there — for the host paths its containers bind-mount, running or
stopped; a process inside the container reads `/proc/self/mountinfo`. When neither can answer — no
runtime, a runtime that knows of no container at all, or a host whose only runtime is plain
`containerd`, which has no interface this knows — `init`, `stage` and `authorize` refuse rather than
guess. The runtime route is deliberately a superset: a directory bind-mounted into *any* container
counts as shared, because any container that can rewrite the broker's code is as good a reason not to
stage there as the agent is.

The sidecar fetches the published `gcb-host` package with `npx` at start. To pin a reviewed commit
instead, run `gcb stage --to "$DEPLOY/app"`, install its dependencies in that directory with
`corepack yarn install`, and pass `--code "$DEPLOY/app"` to `compose`. Run `stage` from the repository
root you intend to export, or pass `--repo <path>`: it defaults to the current directory and exports
that repository's `HEAD`, never the working tree. `stage` is export-only: it does not install
dependencies or build, and it never runs the commit's code. It leaves `STAGED.json` beside the code
recording the commit.

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
a one-off `npx` process.

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
gcb diagnose --config /srv/git-cred-broker/broker.config.yml
```

`probe` prints the broker's decision with the credential reduced to a fingerprint, so its output is
safe to share: exit `0` allowed, `1` denied, `3` broker unreachable. `probe` talks to the socket, so
it runs wherever the pusher runs.

`diagnose` asks GitHub what the app can actually see — the only reliable way to tell "repository does
not exist" from "not selected for this installation", which GitHub reports identically. It reads the
app's **private key**, so run it where the key is. On a host-process deployment that is the host; for
a sidecar it is inside the container:

```sh
docker compose -f docker-compose.broker.yml exec gcb \
  npx --yes --package gcb-host gcb \
  diagnose --config /etc/git-cred-broker/broker.config.yml
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
node --conditions=gcb-development /srv/git-cred-broker/packages/client/bin/gcb.js logs \
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
a pull request's review threads and their comments; `--reply-to` adds a reply inside one, and
`--edit` replaces the body of one of those review comments. The comment id names the comment — and its
pull request — so `--edit` takes no `--number`. GitHub lets only an author change a comment, and the
comments this command posts are the app's, so `--edit` changes those rather than a person's.

### Opening one as yourself

There are three ways to have a pull request authored by a person, and they stay alternatives: the **host
opener** below needs no long-lived secret anywhere and costs a process you keep running; **`userTokens`**
needs no second process and costs a token per owner; and **authorizing the app** needs neither, at the cost
of a token as wide as your own access to GitHub. A deployment picks the trade it prefers, and none of them
replaces another.

A pull request opened through the broker is authored by the app, and automated reviewers are
entitled to skip those. To have one authored by you instead, run the opener on the host, beside the
same checkout, and ask for it from the container:

```sh
# on the host, once — it serves every checkout below $HOME and does nothing else
gcb host-opener          # --root <dir> to narrow it, repeatable
# or, at boot and for good: examples/host-opener-boot.sh (see below)
```

**Copy that file outside the mounts before a task runs it.** It runs as you, so leaving it in the
checkout would let anything that can write the checkout decide what your credentials do at boot.

```sh
# in the container
gcb pr --via-host --repo owner/repo --head feature --base main \
  --title "a title" --body-file pr.md
```

The opener creates pull requests with the credentials of whoever started it, which is the point;
it never runs a shell, and the program it calls is configuration rather than a hard-coded `gh`:
`--command /path/to/gh`, or `$GIT_BROKER_PR_COMMAND`. It cannot push, merge, close or read
anything. `--root` may be repeated and defaults to `$HOME`; checkouts within `--depth` levels of a root
(4 by default) are served with no further setup, including ones created later, which the next sweep
picks up. The bound exists because the walk repeats every `--interval` seconds; raise `--depth` for
deeper layouts. To start it once and keep it,
`examples/host-opener.service` is a systemd user unit; on a system without user services,
`examples/host-opener-boot.sh` is the same thing for a DSM boot-up task — absolute paths, one
instance at a time, and its output in a log file. Without `--via-host`, or with no opener running, `pr` behaves
exactly as before.


A pull request opened with the app's installation token is authored by the app, and automated
reviewers are entitled to skip those. The simplest way to have one authored by you is a
**fine-grained personal access token** in the configuration:

```jsonc
{
  "hosts": {
    "github.com": {
      "provider": "github-app",
      "privateKeyPath": "/etc/git-cred-broker/app.pem",
      "userTokens": { "an-org": "/etc/git-cred-broker/an-org.token" }
    }
  }
}
```

`userTokens` is keyed by owner because that is GitHub's own granularity: a fine-grained token
belongs to one user or organization and cannot span two, so two owners need two tokens. Create each
with **Pull requests: Read and write**, **Contents: Read** and **Metadata: Read**, and give it access
to **only the repositories the allowlist already names**. No contents *write* means
GitHub itself refuses to let that token push or merge, so "it may only open pull requests" is
enforced by GitHub rather than promised here. The token is used for creating and nothing else:
closing, merging, updating and reading a state all stay on the app's installation token. Drop the
field to go back to app-authored pull requests; `--via-host` still works either way.

#### Authorizing as a person instead
Two things the app needs: its **client id** in the configuration (the App ID will not do), and
**Enable Device Flow** selected in its settings, and **Expire user authorization tokens** left on — the
broker renews with the refresh token, and GitHub only issues one while that is selected. No client secret: the device flow does not use one,
so no second long-lived secret joins the key.


A token per owner is one way to be the author; authorizing the app once is another, and it needs no
token per owner, because GitHub issues it for the app *and* the person together. Run this on the host:

```sh
gcb authorize --config /srv/git-cred-broker/broker.config.yml
```

It prints a code and asks you to open <https://github.com/login/device>, then waits. Type the code on
whatever device has a browser. The refresh token is stored beside the private key, which is where the
broker looks for it, and the broker renews it from then on — nothing else needs running.

The user token is used for exactly the two things an installation token cannot do: authoring a pull
request as that person, and resolving a review thread, which GraphQL refuses for an app outright.

The file needs to be **writable by the broker**, unlike the key: GitHub rotates the refresh token on
every exchange, so mount it read-write (`./user.refresh:/etc/git-cred-broker/user.refresh:rw` in the
sidecar). A read-only mount works until the first renewal, which is the worst moment to find out.

The allowlist says what this channel **may be used for**, not what the app is installed on: an entry for a
repository the app was never installed on is meaningful, because `authorize` and the host opener act as a
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
gcb pr status --number 7 --proxy http://proxy.example:7890
```

For `git push`, the credential helper has no per-command argument, so it reads
`GCB_PROXY=<url>` or `GCB_PROXY=` (empty, direct) from git's environment. That controls how the
broker mints the token; Git's own HTTP transport still uses `http.proxy` / `HTTPS_PROXY` /
`NO_PROXY`, so set both when the push itself must follow the same route.

`gh` receives the choice through its process environment; the broker builds a separate
`node-fetch-native` instance for each proxy value and caches it, so commands sharing a choice reuse the
same connection pool. `--via-host` carries the same choice to the host opener, which applies it to its
own `gh pr create`.

The choice comes from the pushing container, so it can override a host proxy policy. A deployment that
must force all egress through one route should not give `gcb-client` to a container it does not trust;
the allowlist and the broker key still bound what that container can reach, not which network path it
uses. The `--via-host` opener honours the same choice while acting as the person, and the person's
token is not bounded by the app key, so only serve checkouts from a container you trust.

The broker, `authorize` and `diagnose` **refuse to start** when a proxy variable is set and `NODE_USE_ENV_PROXY` is
not `1`, instead of reaching GitHub directly by a route nobody chose. `gh`, which the host opener runs,
reads those variables itself (it is Go), so it only needs them to arrive.




#### Keeping it running

On a host with user services, `examples/host-opener.service` is a unit for it:

```sh
npm i -g gcb-host                     # the unit calls the installed CLI
cp examples/host-opener.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now host-opener
loginctl enable-linger "$USER"                          # so it survives logout and starts at boot
journalctl --user -u host-opener -f                     # its output
```

`loginctl enable-linger` is the part that is easy to miss: without it a user service stops when
your last session ends and does not come back at boot. `Restart=always` is already in the unit, so
a crash is a ten-second gap rather than a silent stop.

On a host without user services — a Synology NAS, for instance — `examples/host-opener-boot.sh` is
the same thing for a boot-time task: absolute paths, one instance at a time, its output in a log
file.

## Configuration reference

The broker only reads this file. It is YAML. The loader discovers `broker.config.yml` by default;
the old `broker.config.json` name is no longer discovered, so rename or convert an existing
deployment, or pass `--config broker.config.json` explicitly (the YAML parser accepts JSON). TOML is
not read.

The file normally contains no secrets, but it may: `privateKeyPem` and `static.password` are accepted
inline. When either is used, treat the file as secret material — mode 0600, outside every container
mount.

Top level:

| Key | Default | Meaning |
|---|---|---|
| `socketPath` | — (required) | Absolute path of the unix socket the broker binds. |
| `socketMode` | `432` (0660) | Socket permissions, in decimal. `0660` is right when broker uid == container uid. |
| `auditPath` | `null` | Append-only JSONL. Keep it outside the container's mounts. |
| `tokenCacheSkewSeconds` | `300` | Re-mint a cached credential this long before it expires. |

Per host, keyed exactly as git reports it (`github.com`, or `host:port` for other ports):

| Key | Meaning |
|---|---|
| `provider` | `github-app` or `static`. |
| `allow` | Default-deny list: `owner/repo`, or a whole-segment wildcard `owner/*`. Malformed entries (no slash, three segments, a partial wildcard like `wid*`) are rejected at load time rather than silently matching nothing. |
| `allowInsecureHttp` | Default `false`. Permit a plaintext `http` remote for this host. |

`github-app`: `clientId` (preferred `iss`), `appId` (fallback), `privateKeyPath` or `privateKeyPem`,
`permissions`, `apiBaseUrl` (GitHub Enterprise), `apiVersion`, `installationCacheSeconds`,
`verifyAppPermissions` (default `true`). `permissions` must be a subset of what the app was actually
granted; the broker checks once per process and names any missing permission.

`static`: `username`, `password`, `passwordPath` or `passwordEnv`, `expiresInSeconds`.

`hosts` is validated strictly — a known provider and a non-empty allowlist — so a typo cannot sit
there looking like configuration while doing nothing. Only top-level `_comment*` keys are ignored.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `cannot reach the broker at <path>: ENOENT` | The broker is not running, or `GIT_BROKER_SOCKET` is wrong. Start it; check the socket file exists. |
| `... exists only inside the sidecar container` | The config suits the other deployment. `init --mode sidecar` or `--mode host`. |
| `denied [repo-not-allowed]` | Not in the allowlist: `init --allow owner/repo`. |
| `refusing to replace <path>: something that is not a socket is in the way` | A leftover file sits on the socket path. Remove it and start again. |
| `'credential-node' is not a git command` | The helper value is `node x.ts` without the `!` git needs: `git config --global credential.helper '!node /path/packages/client/bin/gcb.js'`. |
| `could not mint a credential` | Deliberately generic, because provider errors can embed API responses. `diagnose --config …` for the real reason. |
| `server certificate verification failed. CAfile: none` | The image has no CA bundle. `setup` writes one; better, add `ca-certificates` to the image. |
| A host's HTTPS push suddenly asks for a password | The helper stays silent when unconfigured, so the next helper runs; it only refuses (`quit=1`) when `GIT_BROKER_SOCKET` is set or `GIT_BROKER_REQUIRE=1`. |

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
packages/cli/src/        shared parser, protocol, types, platform helpers and the gh action catalog
packages/client/src/     credential helper, setup, probe, logs, pr, gh
packages/host/src/       YAML config, providers, broker, daemon and host commands
packages/*/bin/          the two installed gcb bins (client and host)
test/                    unit tests, plus an end-to-end push over authenticated smart HTTP
examples/                configuration and compose snippets
DEVELOPMENT.md           building from source, tests, releasing
.agents/notes/           the design, its review, and the measured environment facts
```

### Embedding the client in another image

The contract between the pushing container and the broker is deliberately small:

- the helper finds the socket through `GIT_BROKER_SOCKET`; otherwise `GIT_BROKER_SOCKET_FILE`,
  defaulting to `$HOME/.config/git-credential-broker/socket`;
- the broker's own egress uses `http_proxy` / `https_proxy` / `no_proxy` with
  `NODE_USE_ENV_PROXY=1`; the sidecar additionally reads `GCB_PROXY` at `docker compose up`
  time (`<url>` pins a proxy, empty is direct, unset keeps the host variables); every command
  accepts `--proxy` / `--no-proxy`;
- the socket is the only mounted interface; no credential, token or App key is ever placed in
  the pushing container.

`gcb --version` and `gcb gh --help` are the discovery checks inside a base image.

### Images

Two images, in separate registries/repositories, mirror the two packages:

| Image | Contents | Use |
|---|---|---|
| `code-vaults/gcb-client:dev` | `gcb` client and Node runtime only | idsh base / `COPY --from` |
| `code-vaults/gcb-host:dev` | broker, `gh`, and broker dependencies | run `gcb daemon` on the host |

Published equivalents are the same names on GHCR:
`ghcr.io/code-vaults/gcb-client:dev` and `ghcr.io/code-vaults/gcb-host:dev`. A
GitHub repository can publish both packages; they share the source repository without sharing a tag.

For local development, build and reuse the same tags:

```sh
docker build --target client -t code-vaults/gcb-client:dev .
docker build --target host   -t code-vaults/gcb-host:dev .
```

While the image exists locally, Docker uses it instead of pulling from the registry; another machine
or CI pulls the same tags.

For idsh's dev image, name the client image as a stage and copy only the gcb packages into the base:

```dockerfile
ARG BASE=devockr/idsh:base
ARG GCB_CLIENT_IMAGE=code-vaults/gcb-client:dev
FROM ${GCB_CLIENT_IMAGE} AS gcb-client
FROM ${BASE}

COPY --from=gcb-client /usr/local/lib/node_modules/gcb-cli /usr/local/lib/node_modules/gcb-cli
COPY --from=gcb-client /usr/local/lib/node_modules/gcb-client /usr/local/lib/node_modules/gcb-client
RUN ln -s /usr/local/lib/node_modules/gcb-client/bin/gcb.js /usr/local/bin/gcb
```

Copy the two package directories, not all of `/usr/local/lib/node_modules`: the idsh base already has
its own `corepack` and `npm`, and a whole-directory copy would replace them. A CI build passes
`--build-arg GCB_CLIENT_IMAGE=ghcr.io/code-vaults/gcb-client:dev` instead.

### App permissions by action

The action catalog is the source for these requirements; `gcb gh --help` prints the same
actions. Grant them on the App, then approve any changed permissions on each installation.

| Action | App permissions |
|---|---|
| `pr view` | `pull_requests: read`, `contents: read`, `checks: read`, `statuses: read` |
| `pr list` | `pull_requests: read` |
| `pr diff` | `pull_requests: read`, `contents: read` |
| `pr create` | `pull_requests: write`, `contents: read` |
| `pr close` | `pull_requests: write` |
| `pr comment` | `pull_requests: write` |
| `pr review` | `pull_requests: write` |
| `issue create` | `issues: write` |
| `run view` | `actions: read` |
| `run list` | `actions: read` |

A missing `checks` or `statuses` grant is why `gcb pr view 72` can fail while `pr diff` works:
`pr view` reads the checks and statuses endpoints as well. Raising a permission on the App is not
enough by itself — the installation must approve the updated grant.
