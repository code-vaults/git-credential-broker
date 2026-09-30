# AGENTS.md

Working notes for agents in this repository.

`README.md` explains **what** this is and how to deploy it. `.agents/notes/` holds the design
history and the measured environment facts. This file is about **how to work here** without
breaking the invariants that make the thing worth having.

**Keep that split.** The README is for someone who wants to run this: install, quick start,
configuration reference, troubleshooting. Reasoning — why a unix socket, why the code and not just
the key must sit outside the mounts, how a share's ACLs behave, which bug prompted which check —
belongs in `.agents/notes/`, or here when it is a rule about working in this repository. The README
had reached 549 lines mostly by accumulating rationale; it is not the place for it.

## What it is, in one paragraph

A host-side broker holds a GitHub App private key and mints short-lived, single-repository
installation tokens. A helper inside the container holds **nothing** and asks the broker over a
unix socket. `git push` from the container therefore works without any long-lived credential
ever entering the container.

```
container git → helper → unix socket → broker (outside the container) → App key → GitHub
                          └ mounted       └ holds the only secret
```

## Commands

```sh
corepack yarn install    # Yarn 4 via corepack; packageManager pins it

corepack yarn typecheck  # tsc, no emit
corepack yarn build      # to dist/, then makes the CLI entry points executable
corepack yarn check      # typecheck + build + all tests  ← run this before claiming success
corepack yarn pack:check # build, then show exactly what npm would publish
```

The CLI runs from source too, so there is no need to build to try a command:

```sh
node src/cli/helper.ts --help
node src/cli/helper.ts compose --socket-dir /tmp/sock    # reads --config, $GIT_BROKER_CONFIG, else ./broker.config.json
```

`yarn test` builds first because the end-to-end suite execs `dist/cli/helper.js` as a **real**
credential helper. Unit tests run the `.ts` sources directly via Node's type stripping, so
sources must stay erasable (`erasableSyntaxOnly` is on: no enums, no parameter properties).

## Rules that are not obvious from the code

- **Never commit key material.** `.gitignore` covers `*.pem` and `*.key`; a real App private
  key has already been dropped into this directory once. Before pushing:
  `git grep -l 'BEGIN RSA PRIVATE KEY' HEAD` must find nothing.
- **Do not run the broker from this checkout, and understand why the *key* being elsewhere is not
  enough.** The broker reads the key, so the code it executes has the key's privileges: it can mint
  installation tokens for anything the App can see, and it can read the key file. A key outside the
  container buys nothing while the process holding it runs code from an agent-writable directory —
  the agent then owns the allowlist. The boundary is control of the code. `stage` exports a
  **commit** (never the working tree) into a directory outside every mount and records the sha; the
  repository is agent-writable too, so a staged sha is worth checking against a clone or the remote.
  The *helper* is fine here: it holds no secret and grants nothing; the broker decides.
- **Strict configuration validation is deliberate.** Top-level `_comment*` keys are ignored,
  but everything inside `hosts` is checked, and a malformed `allow` entry is rejected at load
  time. It fails closed either way, but silently — and a typo that looks like configuration is
  worse than a crash. Do not soften this to be helpful.
- **Never log the credential.** The audit log records a SHA-256 *fingerprint* plus host, repo,
  DSH session id and expiry. `src/audit.ts` also redacts secret-looking keys defensively
  (`token_fingerprint` is deliberately exempt). The helper prints the credential to stdout
  because that is the git protocol, and to nowhere else.
- **Tests must not depend on the machine.** Pin `HOME`: the helper falls back to
  `$HOME/.config/git-credential-broker/socket`, so an unpinned `HOME` silently turns
  "unconfigured" tests into "configured, broker missing" ones.
- **Use the async process helpers in `test/lib/run.ts` whenever the test process also serves
  HTTP.** `spawnSync` blocks the event loop, so the peer waiting on that server deadlocks. This
  cost real debugging time.
- **Ignore `EPIPE` when writing to a child's stdin.** A command that exits before reading closes
  the pipe; an unhandled stream error there takes down the whole test file and reports a
  misleading failure. This already caused an intermittently red suite.
- **A job log is plain text that can contain NUL bytes.** GitHub logs a Windows step's output as
  UTF-16, so the fetched log carries NULs — enough for `grep` to report "binary file matches", and
  I concluded from exactly that message that the endpoint returns a zip and wrote a reader for it.
  It does not: a log begins with a timestamp, and the giveaway was in the same output, which showed
  `T h e r e   i s   n o …`. Judge it by the first bytes, not by what `grep` calls it.
- **A push to `main` cancels the previous run** (`concurrency` with `cancel-in-progress`). A run
  can therefore end as `cancelled` rather than red or green, and a verdict that looks missing is
  usually one a later push replaced: read the newest run for the commit, not the first.
- **The configuration is found by convention and its paths belong to the broker, not to you.**
  Every command resolves `--config`, else `$GIT_BROKER_CONFIG`, else `./broker.config.json`, and takes
  the deployment directory from the file's own location. The paths *inside* it are resolved by
  the process that runs the broker, so `deployment.ts` holds one definition per deployment and
  both `init --mode` and `compose` read it; a config whose mode does not match the deployment is
  refused rather than half-working. `/broker.config.json` is gitignored here: a personal copy is
  host-specific, the tracked reference is `examples/broker.config.example.json`.
- **`init` merges; it never rewrites what you did not mention.** The configuration file is the
  source of truth, so updates preserve hand edits and `--allow` *adds*. Do not turn this back
  into "regenerate from flags": `--force` replacing the allowlist silently dropped repositories.
- **A `credential.helper` value is a shell command only when it starts with `!`.** Writing
  `credential.helper = node /path/helper.ts` makes git look for a helper *named* `node` and fail
  with `'credential-node' is not a git command`; it must be `!node /path/helper.ts`. A value
  starting with `/` is executed directly and anything else resolves to `git-credential-<value>`,
  which is why a built, executable `dist/cli/helper.js` can be recorded as a bare path and a `.ts`
  cannot. Learned by getting it wrong.
- **`exec 3<>file` creates the file.** Probing a unix socket for liveness that way writes an empty
  regular file once the socket is gone, and then blocks the broker from binding — it refuses to
  replace a non-socket — until someone removes it. Use `net.connect`, or `test -S` first.
- **Adding a provider** is one module in `src/providers/` plus one case in
  `src/providers/index.ts`. The broker, helper, socket protocol, allowlist and audit are
  provider-agnostic.
- **The broker answers the container with generic errors by default**, because provider errors can
  embed API responses. Real reasons go to the host-side log and audit; `git-credential-broker
  diagnose` is how you read them. The deliberate exception is `ProviderConfigError`: errors composed
  from the configuration and a permission name, with nothing from a provider's response body. Those
  are passed through, so a failed push names the missing permission instead of sending the operator
  to a host-side log. Mark an error that way only when nothing from a response body can be in it.

## Environment gotchas (this container)

Full detail and the measurements behind them:
[`.agents/notes/verified/environment/2026-09-30-dsh-container-facts.md`](.agents/notes/verified/environment/2026-09-30-dsh-container-facts.md).

- **`nodeLinker` must be spelled `node-modules`** (hyphen). `node_modules` is silently invalid
  and the install fails with a misleading `YN0012 ... isn't supported by any available linker`.
- **Egress requires the proxy.** Direct connections to github.com hang rather than fail.
  The credential channel is a unix socket, so it is unaffected — that is why it is a socket.
- **The container is recreated often**, so its writable layer is ephemeral. Anything that must
  survive belongs in compose `environment:` or on a mounted path. `~/Workspaces`, `~/.dsh` and
  `~/.dotfiles` are mounts; `/home/app` itself is not; `/volume1` does not exist inside.
- **Do not rely on the executable bit in commits**: this share's ACLs defeat git's exec-bit
  detection, so every sibling repository has `core.fileMode=false`. The exec bit for the CLI
  entry points is applied by `scripts/postbuild.mjs` at build time, and npm sets it for the
  installed bins, so nothing depends on it being tracked.
- **`~/.dsh` lives *inside* the `~/Workspaces` mount**, so "put it in `~/.dsh`" means "put it on
  the shared NAS share". Never treat it as a private location for secrets.

## Where things are

| Path | What |
|---|---|
| `src/broker.ts` | unix socket server, refusal codes, audit records |
| `src/helper.ts` | the container-side credential helper |
| `src/policy.ts` | the authorization decision (default deny, exact segment matching) |
| `src/providers/github-app.ts` | RS256 JWT, installation lookup, permission pre-flight, token cache |
| `test/e2e/push.test.ts` | a real push over authenticated smart HTTP |
| `src/commands/` | the management CLI: `setup`, `init`, `stage`, `compose`, `probe`, `logs`, `diagnose` |
| `src/cli/helper.ts` | the one command that is both the git helper and the CLI |
| `scripts/postbuild.mjs` | build-time fixup: shebang and exec bit on the CLI entry points |
| `.agents/notes/proposed/` | the original design and its review |
| `.agents/notes/verified/` | what was built, and the measured environment facts |
