# git-credential-broker

Short-lived, single-repository git credentials for a container, from a broker on the host that holds
the only long-lived secret. The GitHub App private key never enters the container, and `git push`
still works.

Two commands are installed:

- **`git-credential-broker`** — the credential helper git calls, and the CLI that sets everything up
- **`git-credential-brokerd`** — the broker (a host process, or a Docker sidecar)

## How it works

```
┌─ HOST ──────────────────────────────────────────────────────────────────────┐
│  broker.config.json   allowlist, paths                                      │
│  app.pem              the only long-lived secret: 0600, outside every mount  │
│  audit.jsonl          append-only, unreadable from the container             │
│                                                                             │
│  git-credential-brokerd                                                      │
│    · signs an RS256 app JWT with the private key                             │
│    · resolves owner → installation, mints ONE repository, narrowed           │
│      permissions, one hour                                                   │
│    · caches it, and default-denies everything else                           │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ unix socket (broker uid == container uid)
┌───────────────────────────────────▼─ CONTAINER ─────────────────────────────┐
│  git-credential-broker                                                       │
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
could ask it for credentials. `git-credential-brokerd`, `setup` and `compose` exit with that
explanation — the three commands whose result is specific to the machine running them. `--help` still
works.

**WSL works**, because it is Linux. One trap: the socket directory belongs on the distribution's own
filesystem (`~/git-broker`), never under `/mnt/c` — a Windows-backed 9p/drvfs mount cannot carry a
unix socket, and the broker checks for that before it binds.

CI runs the suite on Linux and inside WSL, and checks both refusals on native Windows
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Install

```sh
npm install -g git-credential-broker
```

Or run it from a checkout. Node 22.6+ strips TypeScript types, so there is nothing to build and no
dependencies to install:

```sh
git clone https://github.com/code-vaults/git-credential-broker /opt/git-credential-broker
node /opt/git-credential-broker/src/cli/helper.ts --help
```

Keep the checkout outside every container mount.

## Set up the GitHub App first

1. **Settings → Developer settings → GitHub Apps → New GitHub App.**
2. Permissions: **Contents: Read and write**, plus **Pull requests: Read and write** if the agent
   should open pull requests. Grant them in the app, not only in the request.
3. Install the app on the account that owns the repositories, granting access to those alone.
4. Download the **private key**; note the **App ID** and **Client ID**.
5. Ignore the client secret — this tool never uses it. Installation tokens are obtained by signing a
   JWT with the private key; the client secret belongs to OAuth user-to-server flows.

## Quick start: sidecar

Docker only; nothing to install on the host. The image is stock `node:24-slim`, and the code is a
read-only mount, so nothing is fetched or built at boot.

```sh
DEPLOY=/srv/git-cred-broker        # broker.config.json, app.pem and log/ live here
SOCKET_DIR=~/.dsh/git-broker       # a host directory the pushing container already mounts

git-credential-broker init --mode sidecar --dir "$DEPLOY" \
  --cert ~/Downloads/app.private-key.pem \
  --allow owner/repo --client-id Iv23li… --app-id 123456

git-credential-broker stage --to "$DEPLOY/app"
git-credential-broker compose --code "$DEPLOY/app" --socket-dir "$SOCKET_DIR" \
  > "$DEPLOY/docker-compose.broker.yml"
docker compose -f "$DEPLOY/docker-compose.broker.yml" up -d
```

`stage` prints the commit it exported; check that sha against your own clone or the remote before
trusting it, since the repository you export from is one an agent can write to. It leaves a
`STAGED.json` beside the code recording where it came from.

Drop `--code` to get a sidecar that fetches the published package with `npx` at start instead.

## Quick start: host process

Use this when the host has Node 22.6+.

```sh
cd /srv/git-cred-broker

git-credential-broker init \
  --cert ~/Downloads/app.private-key.pem \
  --allow owner/repo --client-id Iv23li… --app-id 123456

git-credential-brokerd --check    # validates the config and the key, binds nothing
git-credential-brokerd            # run it under systemd, or a scheduled task
```

Run it as the user that owns the deployment directory: it must read `app.pem` and write the socket
directory and the audit log.

## Point the container's git at the broker

```sh
export GIT_BROKER_SOCKET=/run/git-broker/broker.sock
export GIT_BROKER_REQUIRE=1        # fail closed instead of falling back to another helper
git-credential-broker setup
```

`setup` records `credential.helper` and `credential.useHttpPath` (without the latter, git sends no
repository path and the broker can only authorize host-wide), rewrites `git@github.com:` remotes to
https **inside the container only** so the host's SSH workflow is untouched, and writes a CA bundle
when the image has none. In compose:

```yaml
    environment:
      - GIT_BROKER_SOCKET=/run/git-broker/broker.sock
      - GIT_BROKER_REQUIRE=1
    volumes:
      - ~/.dsh/git-broker:/run/git-broker
```

## Everyday changes

```sh
git-credential-broker init --allow owner/another-repo         # add a repository
git-credential-broker init --remove-allow owner/old-repo      # remove one
git-credential-broker init --replace-allow --allow a/one,b/two
git-credential-broker init --permissions contents=write,pull_requests=write
git-credential-broker init --cert ~/Downloads/new-key.pem     # rotate the key
```

No `--cert`, `--client-id` or `--app-id` is needed once the file exists: `init` changes only what you
pass, prints the before/after allowlist, and leaves hand edits alone. Restart the broker afterwards.

Moving between deployments rewrites the recorded paths in place, keeping the allowlist:

```sh
git-credential-broker init --mode host --socket-path /run/git-cred-broker/broker.sock
```

`--socket-path` is required when moving to host mode, because the socket on file belongs to the
sidecar. Commands find the configuration by convention — `--config`, else `$GIT_BROKER_CONFIG`, else
`./broker.config.json` — so run them from the deployment directory.

## Check it without pushing

```sh
git-credential-broker probe --host github.com --repo owner/repo
git-credential-broker diagnose --config /srv/git-cred-broker/broker.config.json
```

`probe` prints the broker's decision with the credential reduced to a fingerprint, so its output is
safe to share: exit `0` allowed, `1` denied, `3` broker unreachable. `probe` talks to the socket, so
it runs wherever the pusher runs.

`diagnose` asks GitHub what the app can actually see — the only reliable way to tell "repository does
not exist" from "not selected for this installation", which GitHub reports identically. It reads the
app's **private key**, so run it where the key is. On a host-process deployment that is the host; for
a sidecar it is inside the container:

```sh
docker compose -f docker-compose.broker.yml exec git-cred-broker \
  node /opt/git-credential-broker/src/cli/helper.ts \
  diagnose --config /etc/git-cred-broker/broker.config.json
```

### Reading a CI log

`logs` fetches one workflow job's log through the broker. It needs `actions: read` on the app and
nothing else: the broker mints a short-lived token narrowed to that permission, reads the log, and
returns only the text, so no credential reaches this side. The job id is the check run id:

```sh
git-credential-broker logs --host github.com --repo owner/repo --job 1234567890
```

It talks to the socket, so it runs wherever `probe` runs. Off the container there is neither
`GIT_BROKER_SOCKET` nor a socket file, so pass the socket explicitly — and give the CLI an absolute
path, because a relative one is resolved against the current directory, which is not always the
checkout:

```sh
node /srv/git-cred-broker/src/cli/helper.ts logs \
  --socket /srv/git-cred-broker/broker.sock \
  --host github.com --repo owner/repo --job 1234567890
```

### Opening a pull request

`pr` opens one through the broker, the same way `logs` reads one: it mints a token narrowed to
`pull_requests: write` plus read access to the branches it names, posts the request itself, and
prints the number and the URL. No credential reaches this side, so the agent can propose a change
without being able to push to the branch it targets.

```sh
git-credential-broker pr --host github.com --repo owner/repo \
  --head feature --base main --title "a title" --body-file pr.md
```

Both the app and the installation need `pull_requests: write`; without it the error names the
permission instead of failing at GitHub. `--draft` opens it as a draft.

### Opening one as yourself

There is more than one way to have a pull request authored by a person, and they stay alternatives:
this one needs no long-lived secret anywhere and costs a process you keep running; `userTokens`
below needs no second process and costs a token per owner. Neither is replaced by the other, or by
the OAuth app still on the drawing board — a deployment picks the trade it prefers.

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

A token per owner is one way to be the author; authorizing the app once is another, and it needs no
token per owner, because GitHub issues it for the app *and* the person together. Run this on the host:

```sh
git-credential-broker authorize --config /etc/git-cred-broker/broker.config.json
```

It prints a code and asks you to open <https://github.com/login/device>, then waits. Type the code on
whatever device has a browser. The refresh token is stored beside the private key, which is where the
broker looks for it, and the broker renews it from then on — nothing else needs running.

The user token is used for exactly the two things an installation token cannot do: authoring a pull
request as that person, and resolving a review thread, which GraphQL refuses for an app outright.

Two things the app needs: its **client id** in the configuration (the App ID will not do), and
**Enable Device Flow** selected in its settings. No client secret: the device flow does not use one,
so no second long-lived secret joins the key.


A pull request opened through the broker is authored by the app, and automated reviewers are
entitled to skip those. To have one authored by you instead, run the opener on the host, beside the
same checkout, and ask for it from the container:

```sh
# on the host, once — it serves every checkout below $HOME and does nothing else
git-credential-broker host-opener          # --root <dir> to narrow it, repeatable
# or, at boot and for good: examples/host-opener-boot.sh (see below)

# in the container
git-credential-broker pr --via-host --repo owner/repo --head feature --base main \
  --title "a title" --body-file pr.md
```

The opener creates pull requests with the credentials of whoever started it, which is the point;
it never runs a shell, and the program it calls is configuration rather than a hard-coded `gh`:
`--command /path/to/gh`, or `$GIT_BROKER_PR_COMMAND`. It cannot push, merge, close or read
anything. `--root` may be repeated and defaults to `$HOME`, so `~/Workspaces`, `~/.dotfiles` and
checkouts created later are all served with no further setup. To start it once and keep it,
`examples/host-opener.service` is a systemd user unit; on a system without user services,
`examples/host-opener-boot.sh` is the same thing for a DSM boot-up task — absolute paths, one
instance at a time, and its output in a log file. Without `--via-host`, or with no opener running, `pr` behaves
exactly as before.

#### Keeping it running

On a host with user services, `examples/host-opener.service` is a unit for it:

```sh
npm i -g git-credential-broker                          # the unit calls the installed CLI
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

The broker only ever reads this file; it contains no secrets.

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
| `'credential-node' is not a git command` | The helper value is `node x.ts` without the `!` git needs: `git config --global credential.helper '!node /path/src/cli/helper.ts'`. |
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
--local` (it is the same file on both sides); the container's own `~/.gitconfig` is private, but
`~/.dotfiles` is mounted, which is why `setup` refuses to write through a symlink into it.

Credential helpers are only consulted for HTTP(S) remotes, so none of this affects the host's SSH
pushes.

The design record, the review that preceded it, and the measured environment facts are in
[`.agents/notes/`](.agents/notes/).

## Development

Building from a checkout, tests and releasing: [DEVELOPMENT.md](DEVELOPMENT.md). The rules that keep
this working, and the traps it already paid for, are in [AGENTS.md](AGENTS.md).

## Layout

```
src/policy.ts            the authorization decision (default deny, exact segment matching)
src/broker.ts            unix socket server, refusal codes, audit records
src/helper.ts            the container-side credential helper
src/providers/           github-app (RS256 JWT, installation tokens) and static
src/commands/            the CLI: setup, init, stage, compose, probe, diagnose
src/cli/                 the two executables (helper, daemon)
test/                    unit tests, plus an end-to-end push over authenticated smart HTTP
examples/                configuration and compose snippets
DEVELOPMENT.md           building from source, tests, releasing
.agents/notes/           the design, its review, and the measured environment facts
```
