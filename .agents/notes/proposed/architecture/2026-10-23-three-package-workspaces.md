# Three packages: `gcb-core`, `gcb-client`, `gcb-host`

- **Date:** 2026-10-23
- **Status:** proposed; supersedes the single-package + esbuild-bundle plan
- **Context:** production distribution is the npm registry, not a staged source tree.

## Decision

Split the repository into Yarn workspaces under `packages/`:

```text
packages/
  core/      gcb-core      shared command runtime, argument parsing, protocol, types
  client/    gcb-client    container side; depends on gcb-core
  host/      gcb-host      host side; depends on gcb-core and yaml
```

Dependency graph:

```text
gcb-client ──> gcb-core
gcb-host   ──> gcb-core, yaml
```

There is no dependency from `gcb-core` to either side, and no dependency from
`gcb-client` to `gcb-host`. The container installs only `gcb-client`; the host installs only
`gcb-host`. Both top-level packages expose the same `gcb` bin, so the external command is still one
name.

## Why not one package plus optional peers

- npm installs peers in ways that are easy to get wrong; a package boundary is enforced by the
  dependency graph instead of by documentation.
- `gcb-core` is a base dependency, not a dispatcher that owns both backends. It must not be able to
  load `yaml`.
- A missing `yaml` must be impossible on a host and irrelevant in a container, not a runtime
  surprise.

## Bin ownership

`gcb-client` and `gcb-host` each declare `"bin": { "gcb": "./bin/gcb.js" }`. The bin is a thin
wrapper: it imports the shared runner from `gcb-core`, passes its own command backend, and exits with
the result.

`gcb-core` may carry a development bin, but it is not the published entry point. Relying on npm to
link a dependency's bin into the global prefix is not something to build a release on.

Only one of the two top-level packages should be installed in a given environment. Installing both
globally would race for the same `gcb` link; that is documented rather than worked around.

## Command ownership

- `gcb-client` (implemented): `git-credential-*`, `setup`, `probe`, `logs`, `pr`.
- `gcb-host` (implemented): `app`, `host`, `daemon`, `init`, `stage`, `compose`, `diagnose`,
  `authorize`, `host-opener`.
- `gcb-core`: help/version, argument parsing, command lookup, error formatting, and the shared
  wire/types.

`gh` and `config` are roadmap commands, not implemented yet. When `gcb gh` lands it will bypass the
parser and forward its raw arguments.

## No bundling

The npm package installs its dependencies. `yaml` is a normal dependency of `gcb-host` and is not
present in `gcb-client`. `esbuild`, `scripts/bundle.ts`, the CJS `createRequire` shim, and the
staged-bundle build are removed.

`stage` is not a build step for npm production. If it survives, it exports a commit and is explicit
that a commit deployment must install its own production dependencies; it does not build a
self-contained artifact. That is a separate decision from this package split.

## Packaging and tests

- Root is private; `workspaces: ["packages/*"]`.
- Each package has its own `package.json`, `tsconfig.json`, `src/`, `lib/`, and `files`.
- Versions stay in lockstep; `gcb-client` and `gcb-host` depend on the exact `gcb-core` version.
- CI adds a real package test:
  1. `npm pack` all three;
  2. install `gcb-client` into a temporary prefix, assert `gcb --help` and `gcb setup --help`
     work and `yaml` is absent;
  3. install `gcb-host` into another prefix, assert `gcb app --help` and `gcb daemon --help` work
     and `yaml` is present.
- Unit tests may continue to import `packages/*/src` through a development export condition; the
  packaged entry points use `lib`.

## Consequences

- Current `src/` is redistributed by role; imports that cross packages use the package names.
- The current PR (#9) is closed. A new branch starts from `main` with this structure, YAML in the
  host package, no bundle, and the real npm-install test.
- The five open review findings from #9 are addressed in the new branch: YAML sequence comparison,
  map deletion, `--force` regeneration, and the stage/build trust issue (the build step is gone).
