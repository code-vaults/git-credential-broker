# AGENTS.md

Working notes for agents in this repository.

`README.md` explains **what** this is and how to deploy it. `.agents/notes/` holds the design
history and the measured environment facts. This file is about **how to work here** without
breaking the invariants that make the thing worth having.

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
```

`yarn test` builds first because the end-to-end suite execs `dist/cli/helper.js` as a **real**
credential helper. Unit tests run the `.ts` sources directly via Node's type stripping, so
sources must stay erasable (`erasableSyntaxOnly` is on: no enums, no parameter properties).

## Rules that are not obvious from the code

- **Never commit key material.** `.gitignore` covers `*.pem` and `*.key`; a real App private
  key has already been dropped into this directory once. Before pushing:
  `git grep -l 'BEGIN RSA PRIVATE KEY' HEAD` must find nothing.
- **Do not run the broker from this checkout.** It reads the App private key, and this tree is
  agent-writable. It runs from a path outside every container mount — see
  `scripts/deploy-sidecar.sh`. The *helper* is fine here: it holds no secret and grants
  nothing; the broker decides.
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
- **Adding a provider** is one module in `src/providers/` plus one case in
  `src/providers/index.ts`. The broker, helper, socket protocol, allowlist and audit are
  provider-agnostic.
- **The broker answers the container with generic errors on purpose**, because provider errors
  can embed API responses. Real reasons go to the host-side log and audit. Use
  `scripts/diagnose-app.ts` when you need them.

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
  detection, so every sibling repository has `core.fileMode=false`. Invoke scripts as
  `bash script.sh` / `node script.ts`.
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
| `scripts/container-setup.sh` | container-side git configuration (+ TLS trust) |
| `scripts/host-setup.sh` | host-side key install and config generation (native process) |
| `scripts/deploy-sidecar.sh` | host-side deployment as a Docker sidecar |
| `scripts/probe.ts` | ask the broker what it would do, without pushing |
| `scripts/diagnose-app.ts` | why a token mint failed: installations, permissions, repositories |
| `.agents/notes/proposed/` | the original design and its review |
| `.agents/notes/verified/` | what was built, and the measured environment facts |
