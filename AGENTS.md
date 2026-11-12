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

## Status and roadmap

The action/CLI redesign (host-side `gh`, `gcb gh`, host-user delegation) is **underway**. YAML
configuration and the three-package split are implemented. The typed action catalog and
`gcb gh` broker/client path are present; the executor exists but several Phase 2 items remain
incomplete. The root `Dockerfile` builds the client and host image stages, and the old `pr`/`logs`
commands are not removed yet. The Phase 2 design note is in
`.agents/notes/proposed/architecture/2026-10-25-host-side-gh.md`. [`ROADMAP.md`](ROADMAP.md) is authoritative for the target and the order; this file
describes the current tree, which is the last green baseline. Do not
implement a later phase to unblock an earlier one without updating the roadmap first. The target
brand is `gcb`: the CLI, container and service share the name, the main broker is `gcb app`, and
`gcb host` is the host broker (typed host operations, not a shell; service name `gcb-host`).

Keep the roadmap and the skills current as part of the work, not after it:

- every phase updates this file (rules, layout table, commands) and the user-facing README it changes;
- container-facing skills live one directory per skill under `.agents/skills/<name>/SKILL.md` and are
  part of the deliverable, not an afterthought;
- a reversed locked decision gets a design note under `.agents/notes/` and a roadmap update, never a
  silent code change.

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
corepack yarn build      # to lib/, then makes the CLI entry points executable
corepack yarn check      # typecheck + build + all tests  ← run this before claiming success
corepack yarn pack:check # build, then show exactly what npm would publish
```

The CLI runs from source too, so there is no need to build to try a command:

```sh
node --conditions=development packages/client/bin/gcb.js --help
node --conditions=development packages/host/bin/gcb.js compose --socket-dir /tmp/sock    # reads --config, $GIT_BROKER_CONFIG, else ./broker.config.yml
```

`yarn test` builds first because the end-to-end suite execs `packages/client/bin/gcb.js` as a **real**
credential helper. Unit tests run the `.ts` sources directly via Node's type stripping, so
sources must stay erasable (`erasableSyntaxOnly` is on: no enums, no parameter properties).

## Rules that are not obvious from the code

- **`--jq` is caller code running inside gh, so it can read gh's environment.** The token is kept in
  the isolated config when jq is present. The app route refuses `--jq` when a proxy URL carries a
  username or password; the host action route refuses it outright because it runs gh with the
  selected account environment. Do not "fix" either side by adding one variable at a time.

- **Only cover the deployment shapes this project actually supports.** The supported shapes are
  the installed `gcb-client` in the container, the installed `gcb-host` (or a staged commit with
  its production dependencies) on the host, the rendered sidecar, and a source checkout with a
  `gcb` shim for development. Do not add guards, probes, commands or tests for one-off execution
  setup, direct imports of command modules, arbitrary later PATH changes, or native Windows beyond
  the existing refusal and its real-platform CI job.
  `setup` cannot know the PATH of a later git process; do not pretend a setup-time check is a
  guarantee. If a review finding depends on an unsupported shape, answer it in the PR and leave
  the code alone.
- **The gh action catalog is the one source for an action.** `packages/core/src/actions.ts`
  defines its command, flags, positionals, permissions and timeout; the token mint, the creation
  preflight, the command table and the docs must read it rather than keep a second list. The broker
  rebuilds a canonical argv from validated values and never forwards the caller’s argv. Add an
  action only with that command’s GitHub endpoint documentation and a test. Catalogued client
  subcommands dispatch through one primary adapter (`GCB_PRIMARY`, default `gh`); an unsupported
  primary fails closed, and `gcb issue` is a catalog shell through the same adapter rather than a
  second forwarding layer. `gcb gh` accepts bare `--as-user` for `appUser` actions and `--as-user <login>`
  for a catalogued host action; the latter stays a typed, allowlisted request, never raw argv.
- **Dependencies belong to the package that uses them.** `gcb-client` has no runtime dependencies;
  `gcb-host` owns `yaml`. npm installs them; there is no esbuild/bundle step. `stage` is export-only
  and does not install or build, so a commit deployment must install its production dependencies in
  the exported tree before starting the broker.

  The Node floor is checked at runtime, in both entry points, because `engines` is only a declaration here:
  measured, `yarn install` succeeds with `"node": ">=99"`, and `.npmrc` is not read by Yarn 4 at all — so
  neither would catch a host on an older interpreter. A deployment runs from a checkout with no install
  step, which is exactly the case a runtime check covers and an install-time one does not.

- **After writing a fix, read the file back — and never trust a check the shell can rewrite.** Three
  commits in one session described changes the tree did not have: an edit applied after a commit whose
  message claimed it and then discarded by a restore, and a `String.replace` whose replacement contained
  `$$`, which JavaScript reads as one literal dollar, so it wrote the line it was trying to change and
  reported success. The checks that missed it were a `grep -c` output read as success when it printed
  zero, and an ssh command whose remote shell expanded `$$` into its own pid. `split`/`join` instead of a
  replacement string, `sed -n`/`od -c` instead of a pattern a shell touches, and the file read back after
  the commit: a message is not evidence.

- **Look the behaviour up; do not reason about another system from memory.** Two of the four findings a
  free review bot raised on this branch were things it had gone and read: the precedence of Node's
  `--no-use-env-proxy` over `NODE_OPTIONS` and `NODE_USE_ENV_PROXY`, and GitHub's documentation on refresh
  token reuse. Both were answered from memory here, and the memory was wrong in both cases — the first
  version of the fix had the semantics backwards. The rule above says a message is not evidence; neither is
  recall. Check the docs, or run the thing. `web_fetch` and a live invocation are both cheap; being
  confidently wrong about a flag is not.
- **A containment check on a path is not a string prefix.** `resolve()` is lexical, so a symlink inside a
  checkout satisfies a `startsWith` on the served root while pointing at a directory outside it, and the
  container can create one. Compare real paths (`realpathSync`), and ask what else can make a path point
  elsewhere: the first fix for this was a prefix check, and the bypass was found by a review bot asking the
  question the fix had not.

  **The other half is what it compares against.** The directories shared with the container are the
  user's to name, so there is no list to hard-code.
  A process inside the container reads its own mount table (`/proc/self/mountinfo`); a host process asks
  a container runtime — docker, podman or nerdctl, whichever is there — for the paths its containers
  bind-mount, running or stopped, which is a superset on purpose: any container that can rewrite the
  broker's code is as good a reason not to stage there as the agent is. A runtime that knows of no
  container is not an answer — that is exactly when the check is blind, since the agent container may
  simply be stopped with its mounts still configured — so it refuses rather than guesses, as it does
  when nothing can answer at all.

- **The process that owns a boundary decides what crosses it, not the error class.** A response body put
  into the message of a `ProviderConfigError` reached the container, because a caller that wraps that error
  to name a missing permission wraps it in the same class and so passes the whole message through. Detail
  that is only for the host log travels beside the message and is appended by the broker, which is the only
  place that knows which side it is writing to.
- **After a fix, read what the other side received — not just that the suite is green.** The leak above was
  found by running the failed merge again and looking at what the container was told; the JSON was in it.
  In the same way the FIFO, the symlinked `gitdir:` and the symlinked `.git` were each confirmed by
  reproducing the attack, and a fix is not confirmed until the failing case is run again and now passes.
- **When the tree breaks, restore the last green state before doing anything else.** An edit that inserted a
  line into the middle of a call left the broker unable to start, and the next minutes were spent editing a
  file that was already invalid. `git checkout --` back to the commit whose typecheck passed, then fix from
  a read of the real text. Roll back first; a broken tree gets worse with attention, not better.
- **A review round is not finished until every claim has been read, fixed, or answered.** Resolve the ones
  that no longer hold, reply to the ones that are fixed, and say plainly which are left. A thread left open
  is a claim nobody checked, and a bot whose report cannot be read — because the tool truncates it, or
  because its finding is below a preamble — is a gap in the tool worth fixing before the review.
- **Never commit key material.** `.gitignore` covers `*.pem` and `*.key`; a real App private
  key has already been dropped into this directory once. Before pushing:
  `git grep -l -- '-----BEGIN.*PRIVATE KEY-----' HEAD -- ':!AGENTS.md' ':!.agents/notes'` must find
  nothing. Both exclusions are needed and neither is a loophole: this line contains the pattern, and the
  notes quote a directory listing of a key that is readable on this machine — the evidence for why the
  key belongs outside the mounts, not key material.
- **Everything published is public.** The repository, the npm package, README badges,
  `package.json`/`Cargo.toml`/`pyproject.toml` metadata, LICENSE and sponsor links are all visible.
  Do not add personal or deployment detail that the project does not need: real hostnames, usernames,
  checkout paths, key locations, private repository names. Public identity the project deliberately
  publishes — copyright holder, author/maintainer, repository/homepage, funding or sponsor links — is
  allowed; keep it deliberate and minimal. This is a judgement call, not a fixed list of exempt files:
  when unsure, use a placeholder and ask.
- **Do not run the broker from this checkout, and understand why the _key_ being elsewhere is not
  enough.** The broker reads the key, so the code it executes has the key's privileges: it can mint
  installation tokens for anything the App can see, and it can read the key file. A key outside the
  container buys nothing while the process holding it runs code from an agent-writable directory —
  the agent then owns the allowlist. The boundary is control of the code. `stage` exports a
  **commit** (never the working tree) into a directory outside every mount and records the sha; the
  repository is agent-writable too, so a staged sha is worth checking against a clone or the remote.
  The _helper_ is fine here: it holds no secret and grants nothing; the broker decides.
- **Strict configuration validation is deliberate.** Top-level `_comment*` keys are ignored,
  and a malformed `allow` entry is rejected at load
  time. It fails closed either way, but silently — and a typo that looks like configuration is
  worse than a crash. Do not soften this to be helpful. What is checked is the fields the block
  defines: an unknown key inside `hosts` is dropped rather than refused, so a misspelled `permissions` entry
  is not a typo this will catch.
- **Never log the credential.** The audit log records a SHA-256 _fingerprint_ plus host, repo,
  DSH session id and expiry. `src/audit.ts` also redacts secret-looking keys defensively
  (`token_fingerprint` is deliberately exempt). The helper prints the credential to stdout
  because that is the git protocol, and to nowhere else.
- **Tests must not depend on the machine.** Pin `HOME`: the helper falls back to
  `$HOME/.config/git-credential-broker/socket`, so an unpinned `HOME` silently turns
  "unconfigured" tests into "configured, broker missing" ones.
- **Use the async process helpers in `test/common/run.ts` whenever the test process also serves
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
- **A fork push is a host operation, not a container credential.** `gcb push` asks the host broker
  to run `git push` with its own gh account; the container sends only `owner/repo` and a branch, and
  the host rebuilds the HTTPS/SSH URL, rechecks the allowlist and requires force to be explicit. There is no
  person-token credential for git in the container, and no transparent interception of `git push`.

- **Open a pull request; the agent opens it, and can close or update it.**
  `gcb pr` covers most of the lifecycle: `--head`/`--base`/`--title` to open,
  `--number` with none of the acting flags (which updates the title, body or base). Closing is the
  catalogued `pr:close` action: `gcb pr close <number>` (or `gcb gh pr close`), and `--close`
  refuses with a pointer there.
  The broker performs each action without the token leaving it, and prints the number, the URL and
  the state.

  **The agent does not merge on its own, and could not.** There is no merge action; the ruleset requires
  an approving review, so a merge is a human action on GitHub. The point is that the gate is branch
  protection rather than this tool.

  Worth keeping in the rule: the ability to open a pull request does not carry the ability to push
  to the branch it targets — the token is narrowed to `pull_requests: write`. CI runs on
  `pull_request`, so the branch gets the three jobs before anyone merges.

- **A pull request authored by the app is one automated reviewers may skip, so a person can be the
  author instead — through the broker's authorized user token, or through the host broker.**
  Opening a pull request is a person action: use `gcb pr create --as-user` (broker's authorized
  person) by default, or `pr create --as-user <login>` for a specific host account; the latter writes
  a request under `<git dir>/gcb/host-broker` (shared with the host, untracked) for `gcb host`.
  Without a checkout, the same request goes under the shared, pre-created
  `~/.gcb-host/channel` (mode 0700); both sides must see the same path. A process that can write that channel can act as the selected account
  within the allowlist, so its permissions are part of the boundary.
  A plain `gcb pr create` (app identity) is the exception, only when the operator explicitly asks for
  an App-authored PR; automated reviewers may skip those. The flag-only `gcb pr --as-user` form also
  opens with `--head/--title`, and covers review, reply, PR edit, review-comment edit/comment and
  resolve. Bare `issue create/edit/comment/close/reopen --as-user` uses the broker's person action
  token; the login form uses the host broker. It runs no shell, its program is configuration, and it
  cannot push or merge. The generic `gcb gh --as-user <login>` route adds every catalogued action,
  including pull request close/reopen.

  The host broker is started once per machine, not once per repository: it discovers the checkouts under
  its `--root`s (default `$HOME`) within `--depth` levels of each (4 by default), so anything added
  later is picked up by the next sweep. The bound is deliberate — the walk repeats every `--interval`
  seconds — and `--depth` raises it for a deeper layout. The paths on the two sides never have to
  match for checkout channels — each side reads and writes its own view of the same `.git`
  directory — but the global channel requires both sides to see the same `~/.gcb-host` path. A request without an
  explicit `repo` is served in the checkout it was written in; one that names `repo` uses that repository
  and is checked against the allowlist, so no checkout of the target is required. The checkout is a
  mechanism, not a boundary: the container can edit any checkout it can write, its remote included, so
  what a deployment controls is which roots are served, the allowlist and which program runs.
  A request also selects an account directory: any `~/.config/gh-<login>` that exists can be named, and
  a request that names none runs as the host broker's own login. That is a selector, not a gate; a
  deployment controls which account directories exist, and the container chooses among them.

  **More than one way to be the author exists, and none of them replaces another.** The host broker (no
  long-lived secret, one process) and authorization on the existing app (one process, no manual
  rotation, a token that can do anything that person can) answer the same question with different
  trades. A deployment chooses; when adding another, document it beside the existing ones.

  Authorization is not a token to place: `authorize` runs the device flow once from a browser
  somewhere else and leaves a refresh token beside the key, which the broker renews by itself. The user
  token is used where the person's identity is required or preferred: authoring or editing a pull
  request, submitting a review, resolving a review thread (GraphQL refuses that for an app), replying,
  editing or commenting on a review, reading a public repository through `allowPublicRead`, and
  creating an issue through the action path. It needs the client id
  in the configuration and **Enable Device Flow** in the app settings, and no client secret at all. The
  refresh token is rotated on every exchange and written back; not writing it back would work once.

- **The allowlist says what may be used, not what is installed.** An entry for a repository the app was
  never installed on is meaningful: `authorize` and the host broker act as a person, and a person needs no
  permission on an upstream to open a pull request from their fork into it. For those two routes the
  allowlist matters more than it does for the app, not less — a person's token reaches everything that
  person reaches. The installation is a separate question, and the code asks it only when there is nobody
  else to act as.

  An error on this route does not say which gate refused. Adding a repository to the allowlist moves it
  from `repo-not-allowed` to a generic `provider-error`, "could not mint a credential" — which is this
  rule and nothing more: allowed to try, no installation to mint from. `diagnose` answers it directly,
  listing the installations and the repositories each one reaches; asking for a credential for a
  repository the app _is_ installed on is the control that needs no such command.

  **Which actions are left is the operational half.** The host broker creates pull requests, submits
  reviews, replies to review comments, edits pull requests, runs catalogued actions (with
  `--as-user <login>`) — including issue create/edit/comment/close/reopen and pull request
  close/reopen — while bare `--as-user` through the broker also handles review, reply, resolve, edit
  and comment. Every other action still goes through the installation token.
  On a repository the app is not installed on, a pull request can be opened, edited, reviewed, and its
  review comments replied to, edited or resolved with bare `--as-user`; merge has no route. The host
  action route can close a pull request as a person; neither route pushes. Acting as a person, from a
  checkout on the host that holds the person's own credentials or an allowlisted explicit repository,
  is the design.

- **The configuration is found by convention and its paths belong to the broker, not to you.**
  Every command resolves `--config`, else `$GIT_BROKER_CONFIG`, else `./broker.config.yml`, and takes
  the deployment directory from the file's own location. The paths _inside_ it are resolved by
  the process that runs the broker, so `deployment.ts` holds one definition per deployment and
  both `init --mode` and `compose` read it; a config whose mode does not match the deployment is
  refused rather than half-working. `/broker.config.yml` is gitignored here: a personal copy is
  host-specific, the tracked reference is `examples/broker.config.example.yml`.
- **`init` merges; it never rewrites what you did not mention.** The configuration file is the
  source of truth, so updates preserve hand edits and `--allow` _adds_. Do not turn this back
  into "regenerate from flags": `--force` replacing the allowlist silently dropped repositories.
- **A `credential.helper` value is a shell command only when it starts with `!`.** Writing
  `credential.helper = node /path/helper.ts` makes git look for a helper _named_ `node` and fail
  with `'credential-node' is not a git command`; it must be `!node /path/helper.ts`. A value
  starting with `/` is executed directly and anything else resolves to `git-credential-<value>`,
  which is why `setup` records `!gcb` and lets PATH resolve the installed bin; a source checkout that
  is not on PATH spells the interpreter out. Learned by getting it wrong.
- **`exec 3<>file` creates the file.** Probing a unix socket for liveness that way writes an empty
  regular file once the socket is gone, and then blocks the broker from binding — it refuses to
  replace a non-socket — until someone removes it. Use `net.connect`, or `test -S` first.
- **Adding a provider** is one module in `src/providers/` plus one case in
  `src/providers/index.ts`. The broker, helper, socket protocol, allowlist and audit are
  provider-agnostic.
- **The broker answers the container with generic errors by default**, because provider errors can
  embed API responses. Real reasons go to the host-side log and audit; `gcb diagnose` is how you read them. The deliberate exception is `ProviderConfigError`: errors composed
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
  survive belongs in compose `environment:` or on a mounted path. Which directories this deployment
  mounts is the deployment's business — the tool discovers them rather than knowing them — and
  `/home/app` itself is not one of them, nor does `/volume1` exist inside.
- **Do not rely on the executable bit in commits**: this share's ACLs defeat git's exec-bit
  detection, so every sibling repository has `core.fileMode=false`. The exec bit for the CLI
  entry points is applied by `scripts/postbuild.mjs` at build time, and npm sets it for the
  installed bins, so nothing depends on it being tracked.
- **A directory the container shares is not a private location**, even one that looks like the
  tool's own home: this deployment's socket directory lives inside another shared directory, so
  treating it as private would put a secret on the share.

## Where things are

| Path                                                     | What                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/core/src/`                                     | shared parser, help/version, protocol, types, platform, paths and the gh action catalog |
| `packages/client/src/helper.ts`                          | the container-side credential helper                                                    |
| `packages/client/src/primary.ts`                         | the catalogued-action primary adapter (default `gh`)                                    |
| `packages/client/src/commands/`                          | setup, probe, logs, pr, repo, gh, remotes and the shared host-submit helper             |
| `packages/host/src/broker.ts`                            | unix socket server, refusal codes, audit records                                        |
| `packages/host/src/config.ts`                            | YAML configuration                                                                      |
| `packages/host/src/gh.ts`                                | the isolated gh action executor                                                         |
| `packages/host/src/providers/github-app.ts`              | RS256 JWT, installation lookup, permission pre-flight, token cache                      |
| `packages/host/src/device-flow.ts`                       | the device flow: the three exchanges that turn an authorization into a token            |
| `packages/host/src/commands/`                            | init, stage, compose, config, diagnose, doctor, authorize and host                      |
| `Dockerfile`                                             | client and host image stages, with gh in the host stage                                 |
| `packages/client/bin/gcb.js`, `packages/host/bin/gcb.js` | the two installed `gcb` bins                                                            |
| `test/e2e/packages.test.ts`                              | npm pack and install into separate client/host prefixes                                 |
| `scripts/postbuild.mjs`                                  | build-time fixup: shebang and exec bit on the bin files                                 |
| `.agents/notes/proposed/`                                | the original design and its review                                                      |
| `.agents/notes/verified/`                                | what was built, and the measured environment facts                                      |
