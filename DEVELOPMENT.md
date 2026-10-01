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
- `git` and `tar` for the `stage` command.

## Get the source

```sh
git clone https://github.com/code-vaults/git-credential-broker
cd git-credential-broker
corepack yarn install
```

The install pulls devDependencies only (TypeScript and the Node types). **The package itself has no
runtime dependencies, and that is worth keeping**: the broker runs with a private key in reach, so
every dependency would be code running with that key.

## Run it without building

Node strips the types, so `src/` is directly runnable:

```sh
node src/cli/helper.ts --help
node src/cli/helper.ts compose --socket-dir /tmp/sock --config /tmp/deploy/broker.config.json
node src/cli/daemon.ts --config /tmp/deploy/broker.config.json --check
```

Commands find the configuration by convention — `--config`, else `$GIT_BROKER_CONFIG`, else
`./broker.config.json` — so pass `--config` explicitly when working inside the repository, or the CLI
may read whatever personal configuration happens to be sitting in the working tree (`/broker.config.json`
is gitignored, so `git status` will not warn you).

Two consequences:

- The sources must stay **erasable**: `erasableSyntaxOnly` is on (no enums, no parameter
  properties), and relative imports carry the `.ts` extension — `rewriteRelativeImportExtensions`
  turns those into `.js` for `dist/`.
- The `helper` path git invokes must be an executable file or a command with an interpreter. A bare
  `.ts` is neither, which is why the built `dist/cli/helper.js` (shebang plus exec bit) is what
  `setup` records, and why a source checkout has to spell the interpreter out:
  `git config --global credential.helper '!node /path/src/cli/helper.ts'`.

## Build

```sh
corepack yarn build        # tsc -p tsconfig.build.json && node scripts/postbuild.mjs
corepack yarn typecheck    # tsc, no emit
```

Output goes to `dist/`. `scripts/postbuild.mjs` exists for one reason: `dist/cli/helper.js` and
`dist/cli/daemon.js` are the package's `bin` entries, so they need the `#!/usr/bin/env node` shebang
and the executable bit. This repository cannot track that bit (the share it lives on defeats git's
exec-bit detection), so the build applies it every time.

## Use your build

As the CLI, without installing anything:

```sh
node dist/cli/daemon.js --config /tmp/deploy/broker.config.json
```

As the commands a user of the package gets:

```sh
npm install -g .           # or: npm link
git-credential-broker --version
```

As an image, if you would rather pin a build than mount code or fetch at boot:

```dockerfile
FROM node:24-slim
COPY . /src
RUN cd /src && corepack yarn install && corepack yarn build && npm install -g .
```

```sh
docker build -t git-credential-broker:local .
git-credential-broker compose --image git-credential-broker:local > docker-compose.broker.yml
```

Then change the rendered `command:` to the binary the image installed, since the default one fetches
the published package:

```yaml
    command: ["git-credential-brokerd", "--config", "/etc/git-cred-broker/broker.config.json"]
```

## Tests

```sh
corepack yarn test         # builds, then unit + e2e
corepack yarn test:unit    # the .ts sources directly, no build
corepack yarn test:e2e     # needs dist/ — it execs dist/cli/helper.js as a real credential helper
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
- **Use the async helpers in `test/lib/run.ts` when the test process also serves HTTP.**
  `spawnSync` blocks the event loop, and the peer waiting on that server deadlocks.
- **Ignore `EPIPE` when writing to a child's stdin.** A command that exits before reading closes the
  pipe; an unhandled stream error takes down the whole file with a misleading failure.

## Packaging

```sh
corepack yarn pack:check   # builds, then shows exactly what npm would publish
npm pack                   # the tarball itself
```

`files` ships `dist/`, `src/`, `README.md` and `LICENSE`. The notes, the tests and `AGENTS.md` are
not in the tarball, and neither is the git history. `src/` ships so that stack traces and source maps
point at something readable.

## Releasing

1. Bump `version` in `package.json`.
2. `corepack yarn check`.
3. `npm publish` — `prepublishOnly` runs the check again.
4. Re-render any sidecar you generated: `compose` pins `git-credential-broker@<version>`, so it takes
   the new version only when it is rendered again.

## Layout

```
src/policy.ts         the authorization decision (default deny, exact segment matching)
src/socket-protocol.ts the request and response shapes on the socket
src/broker.ts         unix socket server, refusal codes, audit records
src/helper.ts         the container-side credential helper
src/audit.ts          append-only JSONL, with defensive redaction
src/config.ts         strict configuration validation, deployment paths
src/providers/        github-app (RS256 JWT, installation tokens) and static
src/commands/         the CLI: setup, init, stage, compose, probe, diagnose
src/cli/              the two executables (helper, daemon)
scripts/postbuild.mjs the shebang and exec bit on the two binaries
test/unit/            policy, JWT, provider, helper, broker, config, commands, stage, daemon
test/e2e/push.test.ts a real push over authenticated smart HTTP
examples/             configuration and compose snippets
.agents/notes/        the design, its review, the verified record, environment facts
```
