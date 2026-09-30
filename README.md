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
│    config.json              ← allowlist, per-host policy, audit path      │
│    audit.jsonl              ← append-only, container-unreadable           │
│                                                                           │
│  git-credential-brokerd  (Node, no runtime dependencies)                   │
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

### Host: the broker

> **Run the broker from a path outside every container mount.** It reads the private key, so it
> typically runs as root — and `~/Workspaces` is writable by the agent. Executing
> agent-writable code with the broker's privileges would hand the agent exactly what this
> design withholds. `/opt/git-credential-broker` (below) is outside the mounts; a checkout
> under `~/Workspaces` is not, so copy it out before running it.

```sh
git clone <this repository> /opt/git-credential-broker
cd /opt/git-credential-broker
corepack yarn install
corepack yarn build

mkdir -p /volume1/docker/git-cred-broker
cp examples/broker.config.example.json /volume1/docker/git-cred-broker/config.json
$EDITOR /volume1/docker/git-cred-broker/config.json      # set clientId, key path, allowlist
install -m 600 /path/to/app.pem /volume1/docker/git-cred-broker/app.pem
chmod 600 /volume1/docker/git-cred-broker/config.json

# Validate configuration and key access without binding the socket:
node dist/cli/daemon.js --config /volume1/docker/git-cred-broker/config.json --check

# Run it (see examples/docker-compose.snippet.yml for a unit file and a sidecar form):
node dist/cli/daemon.js --config /volume1/docker/git-cred-broker/config.json
```

Or let `scripts/host-setup.sh` do the mechanical part — it installs the key 0600, generates the
configuration, refuses to put the key anywhere the container can read, and validates the
result without binding the socket:

```sh
bash scripts/host-setup.sh \
  --app-pem ~/Downloads/git-credential-broker.private-key.pem \
  --allow code-vaults/git-credential-broker
```

Startup is fail-fast: a missing key or an over-broad configuration stops the broker rather
than letting it come up and deny everything silently.

### Container: the helper

Reach the socket (bind mount it in), then configure this container's git:

```sh
export GIT_BROKER_SOCKET=/run/git-cred-broker/broker.sock
export GIT_BROKER_REQUIRE=1          # fail closed if the socket variable ever goes missing
bash scripts/container-setup.sh
```

> Invoke the scripts with `bash` / `node` explicitly. This workspace lives on a btrfs share
> whose ACLs defeat git's executable-bit detection, so every sibling repository on it has
> `core.fileMode=false` and the exec bit is not tracked. Build output and installed package
> bins still get their exec bits at build/install time.

`container-setup.sh` records the socket path in two places, because one of them is not enough:
the environment (for interactive shells) and `~/.config/git-credential-broker/socket` (which
the helper reads when the environment carries nothing — git is often spawned from a non-login
shell that never sources a profile, and "pushes silently stopped working" is a bad failure).
Setting `GIT_BROKER_SOCKET` and `GIT_BROKER_REQUIRE` in the container's `environment:` in
compose remains the most explicit option; see
[`examples/docker-compose.snippet.yml`](examples/docker-compose.snippet.yml).

`container-setup.sh` also fixes TLS trust, because the image this was built for installs `git`
with `--no-install-recommends` and never installs `ca-certificates`: there is no
`/etc/ssl/certs` at all, so *every* https git operation fails with

```
server certificate verification failed. CAfile: none CRLfile: none
```

Node is unaffected (it bundles its own trust store, which is why `fetch` works in the same
container while `git` does not — a genuinely confusing pair of symptoms). The script writes a
bundle from Node's store to `~/.config/git-credential-broker/ca-bundle.pem` and points
`http.sslCAInfo` at it, so the container works without a rebuild.

> **Better fix:** add `ca-certificates` to the image's apt line, next to `git`. The generated
> bundle is a snapshot that will age; the package gets updated with the image.

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
  the user's global git configuration. `scripts/container-setup.sh` refuses to follow a
  symlink into it, and fails loudly if it finds one.
- **Credential helpers do not affect SSH.** git only consults credential helpers for
  HTTP(S) remotes; `git@github.com:...` goes to `ssh` and never touches them. So configuring a
  helper cannot break the host's SSH pushes.
- **A shared helper can still break the host's HTTPS pushes**, which is why the helper goes
  quiet when it is not configured: with `GIT_BROKER_SOCKET` unset it prints nothing and exits
  0, so git continues to the next helper (keychain, `store`, …). It only refuses with `quit=1`
  when it *is* configured, or when `GIT_BROKER_REQUIRE=1`. Both directions are covered by tests.
- **Remote URLs stay untouched.** The container has no SSH key or agent (its `~/.ssh` holds
  only `known_hosts`), and app tokens are HTTPS-only. `container-setup.sh` therefore sets a
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
2. Put the app's client ID and the key path in `config.json`.
3. Grant the app `Contents: Read and write`, plus `Pull requests: Read and write` if the agent
   should open PRs. Grant in the app settings first; the broker's pre-flight will refuse
   otherwise.
4. Confirm the app is **not** a ruleset bypass actor, and consider a push ruleset blocking
   `**/*.key` and similar paths.

Nothing about the broker needs to change.

### Verifying without pushing

`scripts/probe.ts` exercises the real path — JWT, installation lookup, permission pre-flight,
token mint — and prints the broker's decision with the credential reduced to a fingerprint, so
its output is safe to paste anywhere:

```sh
node scripts/probe.ts --socket /run/git-cred-broker/broker.sock \
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

## Layout

```
src/policy.ts             allowlist and path normalization (the authorization decision)
src/broker.ts             unix socket server, refusal codes, audit
src/helper.ts             the container-side credential helper
src/audit.ts              append-only JSONL with defensive redaction
src/config.ts             strict configuration validation
src/providers/            github-app (RS256 JWT, installation tokens) and static
src/daemon.ts             startup, signals, --check
src/cli/                  the two executable entry points
test/unit/                policy, JWT, provider, helper, broker, redaction
test/e2e/push.test.ts     real push over authenticated smart HTTP
test/lib/                 the git http-backend CGI server and process helpers
examples/                 configuration and compose snippets
scripts/container-setup.sh    container-side git configuration
.agents/notes/            the original design document and its review
```
