# git-credential-broker

A host-side credential broker plus a git credential helper, so an agent running inside a
container can push to GitHub **without any long-lived credential ever entering that container**.

The container gets a helper that holds nothing: no token, no key, no allowlist. It asks a
broker over a **unix socket**, and the broker — running outside the container, reading an
app private key the container cannot reach — mints a **short-lived, single-repository**
credential, or refuses.

---

## Why

The container this was built for has no GitHub credential at all: no `~/.gitconfig`, no
helper, no token file, no environment variable. Giving it one the obvious way would mean
writing the secret into a bind mount the agent can read, and because git and the agent run as
the *same uid*, file permissions cannot hide it: whatever the helper can read, the agent can
read. The only real boundary is a **separate process with a different filesystem view**.

This project is that process, plus the protocol glue that makes `git push` use it.

## How it works

```
┌─ HOST (outside every mount the container can see) ────────────────────────┐
│  /volume1/docker/git-cred-broker/                                         │
│    app.pem      0600 root   ← the only long-lived secret                  │
│    broker.config.json       ← allowlist, per-host policy, audit path      │
│    audit.jsonl              ← append-only, container-unreadable           │
│                                                                           │
│  git-credential-brokerd  (Node, no runtime dependencies)                  │
│    · signs an RS256 app JWT (iat-60s, exp<=600s, iss=clientId)            │
│    · resolves owner -> installation by matching account.login             │
│    · mints ONE repository + narrowed permissions, then caches it          │
│    · refuses unknown host / missing path / unlisted repo (default deny)   │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ unix domain socket
                                │ (host uid == container uid)
┌───────────────────────────────▼─ DSH CONTAINER ───────────────────────────┐
│  git-credential-broker  (the shipped credential helper)                   │
│    get          : validate, forward to the broker, print username/password │
│    store/erase  : no-ops — nothing is ever persisted                       │
│  git config --global credential.helper broker                              │
│  git config --global credential.useHttpPath true                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### Two design decisions worth knowing about

**It is a unix socket, not a LAN HTTP API.** The original design proposed a broker on the LAN
guarded by a shared key. That container's environment makes it actively dangerous:

```
http_proxy = https_proxy = all_proxy = http://192.0.2.20:7890
no_proxy   = localhost,127.0.0.1,::1,[::1]        # does not include the broker
NODE_USE_ENV_PROXY = 1                            # Node 24 honours *_proxy in fetch()
```

A plain-HTTP hop would route the shared key **and the minted token** through a third-party
process on another machine, in cleartext. A filesystem socket is reachable only from this
host, ignores proxy variables entirely, and needs no TLS, nonce or replay window. The
end-to-end suite runs every git and helper process with a dead proxy configured, so any
regression back to HTTP fails the tests.

**`credential.useHttpPath` is mandatory, and its absence fails closed.** git does *not* send
the repository path to a helper by default — measured:

```
default:            protocol=http / host=127.0.0.1:8123
useHttpPath=true:   protocol=http / host=127.0.0.1:8123 / path=owner/name.git
```

Without it, a helper can only be authorized at *host* granularity, which means "every
repository the app can reach". So the helper refuses a path-less request and names the fix,
rather than silently over-granting.

## What it protects, and what it does not

**Protected**

- The private key never enters the container. The container cannot even see `/volume1`.
- No long-lived credential in the container: not in argv, environment, `~/.git-credentials`,
  the remote URL, or any file.
- Credentials are short-lived (one hour), scoped to one repository, and narrowed to
  `contents:write` + `pull_requests:write`.
- The allowlist is host-side and default-deny, so nothing running in the container can widen it.
- Every decision is audited host-side with a timestamp, host, repository, DSH session id and a
  token *fingerprint* — never the token.
- Central revocation: remove the app installation or the app itself.

**Not protected — stated plainly**

1. **The container can still push to anything on the allowlist, for an hour.** It can run the
   helper itself and obtain a token for any allowlisted repository, then use that token for
   more than the push it originally wanted. The gain is not "the agent cannot misbehave"; it is
   "no long-lived secret leaks, the blast radius is bounded by the allowlist, and everything is
   revocable and attributable".
2. **Anything the agent can read, it can push.** `~/Workspaces` is a full writable mount, and
   it contains real secrets — for example readable wildcard TLS private keys under
   `gitlab-ee/config/ssl/`. A leaked wildcard TLS key is a domain-wide MITM, which is a far
   worse outcome than "one extra PR". Treat mount scope as the real control here.
3. **Branch protection is still the last gate.** A GitHub App can be a ruleset *bypass actor*,
   so verify the app is not on that list, and consider a push ruleset blocking paths such as
   `**/*.key`.
4. A plaintext remote is refused by default, but an operator can opt a specific host in with
   `allowInsecureHttp`. That is a deliberate host-side decision.

## Install

```sh
npm install -g git-credential-broker      # or use npx git-credential-broker ...
```

### From a checkout, with no build

Node 22.6+ strips TypeScript types, so a checkout runs as it is: no compile step, no dependencies to
install, and nothing to publish.

```sh
git clone https://github.com/code-vaults/git-credential-broker /opt/git-credential-broker

node /opt/git-credential-broker/src/cli/helper.ts init \
  --cert ~/Downloads/git-credential-broker.private-key.pem \
  --allow code-vaults/my-repo --client-id Iv23li… --app-id 123456
node /opt/git-credential-broker/src/cli/daemon.ts --config /volume1/docker/git-cred-broker/broker.config.json
```

Keep the checkout outside every container mount: the broker runs with the private key in reach.

> **Why the *code* has to be outside the mounts, and not just the key.** The broker reads the key, so
> whatever code it executes has the key's privileges — it can mint installation tokens for anything
> the App can see, and it can read the key file itself. A key that lives outside the container buys
> nothing if the process holding it executes code from a directory the agent can rewrite: the agent
> then chooses the allowlist, or simply ships the key out. The boundary is control of the code, not
> the location of the key.
>
> `stage` exports from a **commit** — never from the working tree, which the agent can edit — into
> the directory the broker will run from, and records which commit it was:
>
> ```sh
> git-credential-broker stage --to /volume1/docker/git-cred-broker/app --ref <sha you reviewed>
> ```
>
> It refuses a target inside a container mount, refuses the deployment directory itself (a `--to`
> typo there would clear `app.pem`), and leaves `STAGED.json` behind so "which code is running with
> my key?" has an answer. Check the sha it prints against your own clone or the remote first: this
> repository is agent-writable too, so its commits are not self-authenticating.

The credential helper can run this way too, but git needs the interpreter spelled out — and a helper
value is only treated as a shell command when it starts with `!`:

```sh
git config --global credential.helper '!node /opt/git-credential-broker/src/cli/helper.ts'
```

Without the `!`, git reads the first word as a helper *name* and reports `'credential-node' is not a
git command`. `setup` records the running script's own path instead, which is what an npm install or
a built checkout wants; a `.ts` file is not executable, so that form needs the `!`.

The paths inside `broker.config.json` are resolved by the **broker process**, not by whoever wrote the
file. A host process sees the host's filesystem; a sidecar sees only what its `volumes:` mount.
So `--mode` picks which deployment the recorded paths must suit, and it has to match how you
start the broker.

Commands find the configuration by convention — `--config`, else `$GIT_BROKER_CONFIG`, else
`./broker.config.json` — so **run them from the deployment directory** and only the things that
genuinely vary appear on the command line.

### Host process (the host has Node)

```sh
cd /volume1/docker/git-cred-broker          # holds broker.config.json, app.pem and log/

git-credential-broker init \
  --cert ~/Downloads/git-credential-broker.private-key.pem \
  --allow code-vaults/my-repo \
  --client-id Iv23lifamTDN4XTLvLuk \
  --app-id 5138420

git-credential-brokerd --check   # validates the configuration and the key, binds nothing
git-credential-brokerd
```

This records `privateKeyPath: /volume1/docker/git-cred-broker/app.pem` and whatever
`--socket-path` you gave it (default `/run/git-cred-broker/broker.sock`).

### Docker sidecar (the usual NAS case: Docker present, Node absent)

A NAS that has Docker usually does not have Node — and the broker does not need a checkout there
at all. `compose` prints a self-contained sidecar that fetches the published package:

```sh
cd /volume1/docker/git-cred-broker

git-credential-broker init --mode sidecar \
  --cert ~/Downloads/git-credential-broker.private-key.pem \
  --allow code-vaults/my-repo \
  --client-id Iv23lifamTDN4XTLvLuk \
  --app-id 5138420

git-credential-broker compose \
  --socket-dir ~/Workspaces/my-project/.dsh/git-broker > docker-compose.broker.yml
docker compose -f docker-compose.broker.yml up -d
```

`compose` reads that same `broker.config.json` and **refuses to emit a sidecar for a config written with
`--mode host`**, because the resulting container would start and then fail to find its own key.

`--mode sidecar` records `/etc/git-cred-broker/app.pem`, `/run/git-broker/broker.sock` and
`/var/log/git-cred-broker/audit.jsonl` — exactly the paths `compose` mounts. Both commands read
that list from one definition, so they cannot drift apart, and a conflicting `--socket-path` in
sidecar mode is **rejected** rather than silently recorded. (They did drift once: `init` recorded
host paths while `compose` mounted the files at container paths, which produced a sidecar that
could not read its own key.)

In both modes `init` installs the key `0600`, generates the configuration and **validates it with
the same code the daemon uses**, so a mistake is caught here rather than at the first push. It
refuses to run inside the container, refuses to put the key anywhere the container can read, and
refuses a malformed allowlist entry.

`broker.config.json` carries this machine's deployment paths and the location of the private key, and it
contains no secrets — the key itself never leaves `app.pem`. Keep it wherever you keep host
configuration, or in your dotfiles; **this repository ignores `/broker.config.json`** so a personal copy
dropped in the working tree is never committed, and the tracked reference stays
[`examples/broker.config.example.json`](examples/broker.config.example.json).

#### Changing it later

`broker.config.json` is the source of truth — the daemon only ever reads it, and it is meant to be
reviewed, kept with your dotfiles, and edited by hand. `init` therefore **merges**: it changes
only what you pass, so nothing has to be repeated and hand edits survive.

```sh
git-credential-broker init --allow code-vaults/another-repo      # add one repository
git-credential-broker init --remove-allow code-vaults/old-repo   # drop one
git-credential-broker init --allow a/one,b/two --replace-allow   # set the list exactly
git-credential-broker init --permissions contents=write,pull_requests=write
git-credential-broker init --cert ~/Downloads/new-key.pem        # rotate the key
git-credential-broker init --mode host --socket-path /run/git-cred-broker/broker.sock
```

No `--cert`, `--client-id` or `--app-id` is needed once the file exists, and the command prints the
before/after allowlist so the change is reviewable. It refuses to write an empty allowlist, and
`--force` is only for regenerating a file from flags. Restart the broker to pick a change up.

The last line is how you move between deployments: `--mode` switches the *recorded paths* in place
and keeps the allowlist and the app identity, where it once demanded `--force` and a full
re-specification. Moving **to** host mode requires `--socket-path`, because the socket on file
belongs to the sidecar and a host process cannot bind it. A config whose layout does not match how
you started the broker is refused at startup with that explanation rather than an `ENOENT` for a
path that only exists in the other deployment.

> Earlier this was both awkward and dangerous: adding one repository required re-supplying every
> flag, and `--force` then silently *replaced* the allowlist, so adding `b/two` could quietly drop
> `a/one`.

The sidecar runs with the key mounted read-only, no published ports, no capabilities and a
read-only root filesystem. There is nothing to copy and nothing to build, which is the point of
publishing to npm.

> **Run the broker from outside every container mount.** It reads the private key, so it
> typically runs as root — and `~/Workspaces` is writable by the agent. Executing agent-writable
> code with the broker's privileges would hand the agent exactly what this design withholds.

Because the socket lands in a directory the pushing container already mounts, **that container
needs no change and no restart** after the sidecar starts.

Startup is fail-fast: a missing key or an over-broad configuration stops the broker rather
than letting it come up and deny everything silently.

### Container: point git at the broker

```sh
export GIT_BROKER_SOCKET=/run/git-cred-broker/broker.sock
git-credential-broker setup
```

`setup` replaces the hand-written shell script and does four things, each for a reason that was
measured rather than assumed:

- records `credential.helper` — using the running script's real path, so it works for a global
  install as well as for an `npx` cache — and turns on `credential.useHttpPath`, without which
  git sends no repository path and the broker can only authorize host-wide;
- rewrites `git@github.com:` remotes to https **in this environment only**, because an App
  installation token cannot be used over ssh and this is usually a container with no ssh key at
  all;
- writes a CA bundle when the image has none (see the TLS note below);
- records the socket path in a file as well as in the environment, because git is often spawned
  from a non-login shell that never sources a profile — "pushes silently stopped working" is a
  bad failure.

It refuses to write through a symlink, which is not hypothetical: on the host `~/.gitconfig` is
a symlink into `~/.dotfiles`, and that directory is mounted into the container.

> **Making it survive a container rebuild.** `setup` writes into the container's own filesystem,
> which a rebuild wipes. To make it permanent, put the config on a mount and point git at it from
> the container's `environment:` in compose:
>
> ```yaml
> - GIT_CONFIG_GLOBAL=/home/app/.dsh/git-broker/gitconfig
> - GIT_BROKER_SOCKET=/home/app/.dsh/git-broker/broker.sock
> - GIT_BROKER_REQUIRE=1
> ```
>
> generating that file once with
> `git-credential-broker setup --gitconfig /home/app/.dsh/git-broker/gitconfig`. Note that
> `GIT_CONFIG_GLOBAL` *replaces* `~/.gitconfig` rather than merging into it.

> **TLS.** If the image installs `git` with `--no-install-recommends` and never installs
> `ca-certificates`, `/etc/ssl/certs` may not exist at all, and *every* https git operation fails
> with `server certificate verification failed. CAfile: none CRLfile: none`. Node is unaffected
> because it bundles its own trust store, which makes the symptom look like an application bug
> rather than a missing package. `setup` detects this and writes a bundle from Node's store.
> **Adding `ca-certificates` to the image is the better fix**, since a generated bundle is a
> snapshot that ages.

## Working with the bind-mounted `~/Workspaces`

`~/Workspaces` is shared with the host, which pushes over **SSH** with its own credentials.
That has concrete consequences:

- **Repository-local config is shared.** `.git/config` inside any workspace is the same file on
  both sides. Never set credentials with `git config --local`; use `--global`, which writes the
  container's own `~/.gitconfig`.
- **The container's global config is genuinely private.** `/home/app` is not a bind mount
  (verified: only `~/Workspaces`, `~/.dsh` and `~/.dotfiles` are), so the container's
  `~/.gitconfig` does not exist on the host.
- **Never write `~/.dotfiles/gitconfig`.** That directory *is* mounted, and on the host it is
  the user's global git configuration. `git-credential-broker setup` refuses to follow a
  symlink into it, and fails loudly if it finds one.
- **Credential helpers do not affect SSH.** git only consults credential helpers for
  HTTP(S) remotes; `git@github.com:...` goes to `ssh` and never touches them. So configuring a
  helper cannot break the host's SSH pushes.
- **A shared helper can still break the host's HTTPS pushes**, which is why the helper goes
  quiet when it is not configured: with `GIT_BROKER_SOCKET` unset it prints nothing and exits
  0, so git continues to the next helper (keychain, `store`, …). It only refuses with `quit=1`
  when it *is* configured, or when `GIT_BROKER_REQUIRE=1`. Both directions are covered by tests.
- **Remote URLs stay untouched.** The container has no SSH key or agent (its `~/.ssh` holds
  only `known_hosts`), and app tokens are HTTPS-only. `setup` therefore sets a
  container-global `url."https://github.com/".insteadOf "git@github.com:"`, which rewrites the
  remote *inside the container only*. The repository's shared `.git/config`, and the host's SSH
  workflow, are left exactly as they were.

## Configuration reference

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
| `allow` | Default-deny list: `owner/repo`, or a whole-segment wildcard `owner/*`. A malformed entry (no slash, three segments, a partial wildcard like `wid*`) is rejected at load time rather than silently matching nothing. |
| `allowInsecureHttp` | Default `false`. Permit a plaintext `http` remote for this host. |

`github-app`: `clientId` (preferred `iss`), `appId` (fallback), `privateKeyPath`/`privateKeyPem`,
`permissions`, `apiBaseUrl` (GitHub Enterprise), `apiVersion`, `installationCacheSeconds`,
`verifyAppPermissions` (default `true`).

**The client secret is not used anywhere.** Installation access tokens are obtained by signing
a JWT with the app's *private key*; the client secret belongs to OAuth user-to-server flows,
which this design does not use. Treat it as a plain secret to be rotated, not as configuration.

`permissions` must be a subset of what the app was actually granted. The broker checks this
once per process via `GET /app` and fails with a message naming the missing permission,
because GitHub answers `422` for an ungranted request and that is easy to misread as a broker
fault. Set `verifyAppPermissions: false` only when pointing at a mocked API.

`static`: `username`, `password`, `passwordPath`, or `passwordEnv`, `expiresInSeconds`.

The `hosts` object is validated strictly — every entry must be a real host with a known
provider and a non-empty allowlist — so a typo cannot sit there looking like configuration
while doing nothing. Only top-level `_comment*` keys are ignored.

## Development

Yarn 4 with a real `node_modules` tree, and TypeScript sources that Node can also run directly.

```sh
corepack yarn install
corepack yarn typecheck     # tsc, no emit
corepack yarn build         # to dist/, then makes the CLI entry points executable
corepack yarn test          # builds, then runs unit + end-to-end tests
corepack yarn check         # typecheck + test
```

- **Yarn:** `packageManager` pins 4.18.1 and corepack fetches it. Note that the accepted
  `nodeLinker` value is **`node-modules`** (hyphen): writing `node_modules` is silently invalid,
  and the install then fails with `"@types/node@npm:... isn't supported by any available linker"`
  (YN0012), naming an innocent package rather than the config key.
- **Node:** `>=22.6`. The test suite runs the `.ts` sources directly via Node's type stripping
  (hence `erasableSyntaxOnly` in `tsconfig.json`); the compiled `dist/` targets Node 20+.
- **Dependencies:** TypeScript and `@types/node` are dev-only. The broker and helper have **no
  runtime dependencies** — JWT signing uses `node:crypto`, and the GitHub API is called with the
  built-in `fetch`.
- Node runs `.ts` specifiers directly, and `tsc` rewrites them to `.js` on emit
  (`rewriteRelativeImportExtensions`), so the same sources work uncompiled in tests and
  compiled in production.

## Verified behaviour

`corepack yarn check` — **81 tests, 0 failures** (72 unit, 9 end-to-end). The end-to-end suite
drives a real `git http-backend` server that demands HTTP Basic auth, with the credential
supplied only by the shipped helper and broker:

```
▶ end-to-end push through the broker
  ✔ authenticates a real git push and lands the commit
  ✔ records the grant in the audit log with a fingerprint instead of the secret
  ✔ refuses a fetch with no credentials at all, proving the server enforces auth
  ✔ denies repositories that are not allowlisted, and never prefix-matches
  ✔ refuses a path-less credential request before ever contacting the broker
  ✔ stops the helper chain instead of falling through to another helper
  ✔ serves the credential over a unix socket, never through the proxy environment
▶ end-to-end failure behaviour
  ✔ refuses a plaintext remote unless the host has opted in
  ✔ fails fast and closed when the broker is gone
```

The GitHub App path was also exercised against the live API: with a placeholder client ID,
`api.github.com` answered `404 Integration not found` rather than `401 Bad credentials`, which
means the RS256 JWT was accepted as well-formed.

Bugs found and fixed while building this (each now covered by a test): `acme/..` slipped
through the repository-path pattern as a traversal; `readAll` assumed `Buffer` chunks; the
audit redaction regex swallowed `token_fingerprint` along with real tokens; and the
plaintext-vs-TLS decision was initially enforced in the helper, where the agent could reach it,
instead of host-side in the broker.

The first real app this was pointed at had only `contents: write` granted while the example
configuration requested `pull_requests: write` — which GitHub would have answered with a bare
`422` at push time. That is why the broker now pre-flights `GET /app` and names the missing
permission instead.

The suite was also intermittently failing until it was reproduced deliberately: writing to a
child process's stdin after that process had already exited raised an unhandled `EPIPE`, which
took down the whole test file and reported a misleading error instead of the real assertion.
Both the process helper and the CGI server now ignore `EPIPE`, and the combined suite passes
repeatedly (6/6 before, 0/6 failures after).

Finally, the first attempt to actually reach github.com over https from the container failed
with `server certificate verification failed. CAfile: none` — not a broker problem at all, but
a missing `ca-certificates` package in the image. See the TLS note in the install section; the
container-side chain was verified working once trust was supplied.

## Remaining step for a real GitHub App

Everything above is wired and tested against a local authenticated server. To point it at real
GitHub you still need to:

1. Create the GitHub App, install it on the repositories in `allow`, and download the private
   key. Confirm the app is installable on the account that owns those repositories: a *private*
   app can only be installed on the account that owns it.
2. Put the app's client ID and the key path in `broker.config.json`.
3. Grant the app `Contents: Read and write`, plus `Pull requests: Read and write` if the agent
   should open PRs. Grant in the app settings first; the broker's pre-flight will refuse
   otherwise.
4. Confirm the app is **not** a ruleset bypass actor, and consider a push ruleset blocking
   `**/*.key` and similar paths.

Nothing about the broker needs to change.

### Verifying without pushing

`git-credential-broker probe` exercises the real path — JWT, installation lookup, permission
pre-flight, token mint — and prints the broker's decision with the credential reduced to a
fingerprint, so its output is safe to paste anywhere:

```sh
git-credential-broker probe --socket /run/git-cred-broker/broker.sock \
  --host github.com --repo code-vaults/example-repo
```

```
allowed: github.com/code-vaults/example-repo over https
  username      : x-access-token
  expires_at    : 2026-09-30T17:47:08.493Z
  credential    : present, fingerprint 3bc6bcd79494 (value not printed)
```

Exit codes: `0` allowed, `1` denied, `3` broker unreachable. A missing installation, an
ungranted permission or an unlisted repository is diagnosed here instead of halfway through a
push.

### When the broker says only "could not mint a credential"

The broker deliberately answers the container with a generic message, because provider errors
can embed API responses. `diagnose` asks GitHub directly and prints what the app can actually
see:

```sh
git-credential-broker diagnose --config /volume1/docker/git-cred-broker/broker.config.json
```

```
app            : git-credential-broker (id 5138420)
app permissions: {"contents":"write","metadata":"read","pull_requests":"write"}
installation 166588823
  account            : code-vaults (Organization)
  repository access  : all
  repositories (2): code-vaults/example-one, code-vaults/example-two

verdict:
  code-vaults/git-credential-broker: NOT in the repositories this installation can see
```

This exists because GitHub returns the *same* `422` whether a repository was never created or
merely was not selected for the installation, and the message names neither. Note the trap the
implementation itself fell into first: `repository access: all` does **not** mean any name works
— it means every repository that exists, so a repository that does not exist still fails. Only
enumerating the actual repositories tells the two apart.

## Layout

```
src/policy.ts             allowlist and path normalization (the authorization decision)
src/broker.ts             unix socket server, refusal codes, audit
src/helper.ts             the container-side credential helper
src/audit.ts              append-only JSONL with defensive redaction
src/config.ts             strict configuration validation
src/providers/            github-app (RS256 JWT, installation tokens) and static
src/daemon.ts             startup, signals, --check
src/commands/             the management CLI: setup, init, compose, probe, diagnose
src/cli/                  the two executable entry points (helper + daemon)
test/unit/                policy, JWT, provider, helper, broker, config, commands
test/e2e/push.test.ts     real push over authenticated smart HTTP
test/lib/                 the git http-backend CGI server and process helpers
examples/                 configuration and compose snippets
.agents/notes/            the original design, its review, and the verified record
```
