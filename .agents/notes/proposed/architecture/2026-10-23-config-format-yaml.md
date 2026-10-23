# Configuration format: YAML, not TOML

- **Date:** 2026-10-23
- **Status:** proposed; reverses the earlier TOML decision in `ROADMAP.md`
- **Context:** the Phase 1 configuration work had switched `broker.config.json` to
  `broker.config.toml` with `smol-toml`.

## Why this reverses the TOML decision

The configuration is hand-edited and is meant to stay reviewable. Comments are part of that. The TOML
implementation used `smol-toml`, whose `stringify` does not preserve comments. `init` merges the parsed
document and writes the whole file again, so every `init --allow ...` silently removed hand-written
comments. A format whose main advantage disappears on the first update is not worth its dependency.

The alternatives were:

- **TOML with a comment-preserving CST.** Taplo is no longer maintained, and the remaining TOML
  parsers do not expose a practical comment-preserving editing API.
- **TOML plus text-level patches.** Possible, but it means handling multi-line arrays, comments,
  quoting and escaping by hand; more code and more edge cases than the format is worth.
- **JSONC with `jsonc-parser`.** `modify`/`applyEdits` preserve comments and formatting, but it keeps
  JSON's nested-object shape and is not a standard format.
- **YAML with `yaml`.** `parseDocument` / `setIn` / `toString` preserve comments and formatting around
  the edited node; the library is pure JavaScript, maintained, and bundles with esbuild.

YAML is the selected format. The fact that later phases will add dependencies and need the bundle
anyway makes the pure-JS parser acceptable; no native or WASM component is introduced.

## What is locked

- Default file: `broker.config.yml`.
- `.yaml` is accepted when named explicitly. The loader is extension-agnostic; there is no
  auto-discovery between `.yml` and `.yaml`, so two files in one directory cannot race.
- No JSON or TOML compatibility layer. An existing config is converted once when upgrading.
- The parser is the `yaml` package, in `parseDocument` mode, with:
  - `schema: 'core'` (no YAML 1.1 `yes`/`no`/`on`/`off`);
  - `maxAliasCount: 0` (no anchors/aliases in configuration);
  - `uniqueKeys: true`;
  - no custom tags.
- `init` edits a `Document` and writes `doc.toString()`. It does not parse to a plain object and
  serialize it back, because that is what loses comments.
- The fixed deployment path becomes `/etc/git-cred-broker/broker.config.yml`; `compose` and the
  deployment guard follow it. The guard also recognizes `.toml`, `.json` and `.yaml` as deployment
  files, so an unconverted config cannot be deleted by a restage.
- Examples use `examples/broker.config.example.yml`.

## YAML hazards and their handling

- **Implicit typing.** `schema: 'core'` keeps `yes`/`no`/`on`/`off` as strings. Values that could be
  misread (host:port keys, `acme/*` globs, dates, numbers used as strings) are quoted in the example
  and called out in the README.
- **Indentation.** Two spaces, mappings only; the example is the reference.
- **Anchors/aliases.** Disabled with `maxAliasCount: 0`; a config that uses them is rejected.
- **Duplicate keys.** Rejected.
- **Comments on an edited line.** `setIn` preserves comments elsewhere; an inline comment on the
  exact value being replaced may be lost. A test fixes the observable behavior so this cannot silently
  regress into losing all comments.

## Consequences

- `smol-toml` is removed; `yaml` is added as the only runtime dependency and is bundled.
- `init`, `loadConfig`, examples, README, AGENTS, ROADMAP and tests change from TOML to YAML.
- The bundle/stage work is unchanged: install in the staged tree, bundle with esbuild, publish without
  `node_modules`.
- The Windows platform refusal still runs before the configuration import, so the dependency-free
  Windows job does not need `yaml` installed.

## Open follow-up

- Exercise a real `init --allow` on a commented YAML file and assert the unrelated comments survive.
- Decide whether `init` should also be able to create a new file from a commented template rather than
  serializing a bare object; the first version can add comments after writing.
