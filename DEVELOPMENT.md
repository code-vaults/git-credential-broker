# Development

How to build, test and run this from a local checkout, rather than from the published package.

- **Using it?** [README.md](README.md)
- **Changing it?** [AGENTS.md](AGENTS.md) has the rules that are easy to break
- **Why it is built this way?** [`.agents/notes/`](.agents/notes/) has the design, its review, and
  the measured environment facts

## Requirements

- **Node 24 or newer** — the CLI runs TypeScript directly, which is what makes a checkout usable
  without a build step. Verified on Node 24.
- **Yarn 4**, through corepack. `corepack enable` once, or prefix every command with `corepack`.
  `packageManager` in `package.json` pins the version.
- `git` for the `stage` command. `stage` is export-only; a commit deployment installs its own
  production dependencies.

## Get the source

```sh
git clone https://github.com/code-vaults/git-credential-broker
cd git-credential-broker
corepack yarn install
```

The install links the three workspaces and pulls TypeScript, the Node types and `yaml` for `gcb-host`.
`gcb-client` has no runtime dependencies; `gcb-host` owns `yaml`. The broker runs with a private key
in reach, so keep host dependencies deliberate.

## Run it without building

Node strips the types, so the package sources are directly runnable with the development export
condition:

```sh
node --conditions=development packages/client/bin/gcb.js --help
node --conditions=development packages/host/bin/gcb.js compose --socket-dir /tmp/sock --config /tmp/deploy/broker.config.yml
node --conditions=development packages/host/bin/gcb.js daemon --config /tmp/deploy/broker.config.yml --check
```

Commands find the configuration by convention — `--config`, else `$GIT_BROKER_CONFIG`, else
`broker.config.yml` — so pass `--config` explicitly when working inside the repository, or the CLI
may read whatever personal configuration happens to be sitting in the working tree (`/broker.config.yml`
is gitignored, so `git status` will not warn you).

Two consequences:

- The sources must stay **erasable**: `erasableSyntaxOnly` is on (no enums, no parameter
  properties), and relative imports carry the `.ts` extension — `rewriteRelativeImportExtensions`
  turns those into `.js` for `lib/`.
- The `helper` command must resolve to an executable. `setup` records `!gcb`, so git resolves the
  globally installed bin through PATH; a source checkout can use the same config if it has a `gcb`
  shim on PATH, or spell the interpreter out explicitly with
  `git config --global credential.helper '!node --conditions=development /path/packages/client/bin/gcb.js'`.

## Build

```sh
corepack yarn build        # tsc per package + scripts/postbuild.mjs
corepack yarn typecheck    # tsc, no emit
```

Output goes to `packages/*/lib/`. `scripts/postbuild.mjs` exists for one reason: the two
`packages/*/bin/gcb.js` files are the package `bin` entries, so they need the
`#!/usr/bin/env node` shebang and the executable bit. This repository cannot track that bit (the share it lives on defeats git's
exec-bit detection), so the build applies it every time.

## Use your build

As the CLI, without installing anything:

```sh
node --conditions=development packages/host/bin/gcb.js daemon --config /tmp/deploy/broker.config.yml
```

As the commands a user of the package gets:

```sh
mkdir -p /tmp/gcb-packs
npm pack ./packages/core ./packages/host --pack-destination /tmp/gcb-packs
npm install -g /tmp/gcb-packs/gcb-core-*.tgz /tmp/gcb-packs/gcb-host-*.tgz
gcb --version
```

### Deploying the dev images

The two dev tags are built from the current checkout and are never pushed:

```sh
docker build --network=host --target host   -t code-vaults/gcb-host:dev .
docker build --network=host --target client -t code-vaults/gcb-client:dev .
```

The `host` image carries `gcb` and `gh` and runs the broker. The `client` image is the
embedding source for an idsh-style base (`COPY --from=...`); it is not a second broker.

Render a deployment for the host image on the host that runs it:

```sh
DEPLOY=/path/to/deployment
SOCKET_DIR=/path/to/shared/socket
PUSHER_UID=1000
PUSHER_GID=1000
gcb compose --dir "$DEPLOY" --socket-dir "$SOCKET_DIR" \
  --user "$PUSHER_UID:$PUSHER_GID" --image code-vaults/gcb-host:dev \
  > "$DEPLOY/docker-compose.yml"
```

Change only the generated final `exec npx ...` to `exec gcb daemon`, because the dev image already
installs the package; do **not** keep a staged `/opt/gcb` mount, or the image's code is ignored.
Then recreate from the deployment directory, choosing the proxy at runtime:

```sh
cd "$DEPLOY" && GCB_PROXY=http://proxy.example:7890 docker compose up -d --force-recreate
docker compose logs --tail 20 gcb
```

Verify from the pushing side:

```sh
gcb probe --repo owner/repo
```

`GCB_PROXY` is read at `docker compose up` time. An unset value keeps the host proxy variables, an
empty value goes direct, and a URL overrides them; changing it needs `--force-recreate`.

## Tests

```sh
corepack yarn test         # builds, then unit + e2e
corepack yarn test:unit    # the .ts sources directly, no build
corepack yarn test:e2e     # needs the built client bin as a real credential helper
corepack yarn check        # typecheck + build + everything; run this before claiming anything works
```

The end-to-end test needs no network: it serves `git-http-backend` locally and pushes to it through
the real helper and a real broker.

The suite is **POSIX-flavoured** and does not run on Windows today: it execs `git http-backend`,
pins `HOME`, and one test writes a `#!/bin/sh` decoy helper.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) has three jobs: the suite on Linux, the
refusals on native Windows — the broker and `setup` must exit non-zero there, which the unit tests
can only simulate by injecting `'win32'` — and the suite again inside WSL, copied off `/mnt/<drive>`
first because that mount cannot carry the unix sockets the end-to-end test creates. The two Windows
jobs are new and have not been run; expect the first iteration to need fixing.

If you add tests, three traps are already paid for in this suite:

- **Pin `HOME`.** The helper falls back to `$HOME/.config/git-credential-broker/socket`, so an
  unpinned `HOME` silently turns an "unconfigured" test into a "configured, broker missing" one.
- **Use the async helpers in `test/common/run.ts` when the test process also serves HTTP.**
  `spawnSync` blocks the event loop, and the peer waiting on that server deadlocks.
- **Ignore `EPIPE` when writing to a child's stdin.** A command that exits before reading closes the
  pipe; an unhandled stream error takes down the whole file with a misleading failure.

## Packaging

```sh
corepack yarn pack:check   # shows exactly what each of the three packages would ship
npm pack ./packages/core      # the tarball itself
npm pack ./packages/client
npm pack ./packages/host
```

Each package ships `lib/`, plus `bin/` for the client and host. The notes, the tests and
`AGENTS.md` are not in the tarballs, and neither is the git history. `src/` does not ship:
debug a published package from `lib/` and its source maps; the maps point back at `../src`, so keep
the checkout of that version beside them.

## Releasing

Published changes are versioned with Changesets:

1. Add a changeset with `corepack yarn changeset` in the pull request that changes a published package.
   There is no CI gate for this; with no changesets, `changeset publish` only publishes versions npm
   does not have yet.
2. The release workflow uses `changesets/action` to open or update `chore: release packages`. Merging
   that pull request runs `changeset publish`.
3. `@changesets/changelog-github` writes the changelog entries; each package's `prepack` runs
   `clean-pkg-json`, so the published manifest omits the workspace-only `development` export.
4. The same release builds and publishes the `gcb-client` and `gcb-host` images.
5. Re-render any sidecar you generated: `compose` pins `gcb-host@<version>`, so it takes
   the new version only when it is rendered again.

The release workflow uses npm trusted publishing (OIDC): `id-token: write` is granted, no
`NPM_TOKEN` secret is read. Configure the npm package's trusted publisher for this repository first.
The two images are published to GHCR only.

Also configure:

- **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** on;
  `changesets/action` cannot open the version pull request without it

## Layout

```
packages/core/src/      parser, help/version, protocol, types, platform and paths
packages/client/src/   credential helper, setup, probe, logs and pr
packages/host/src/     YAML config, providers, broker, daemon and host commands
packages/*/bin/gcb.js  the two installed bins (client and host)
scripts/postbuild.mjs  the shebang and exec bit on the two bins
test/unit/             policy, JWT, provider, helper, broker, config, commands, stage, daemon
test/e2e/push.test.ts  a real push over authenticated smart HTTP
test/e2e/packages.test.ts  npm pack and install into separate client/host prefixes
examples/              configuration and compose snippets
.agents/notes/         the design, its review, the verified record, environment facts
```
