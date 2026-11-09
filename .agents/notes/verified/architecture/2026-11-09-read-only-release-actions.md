# Read-only release actions are allowed

## Context

`ROADMAP.md` listed `release` as a built-in hard deny. #85 then asked for a release
domain, and #114 added `release:list` and `release:view`; the release shipped in 0.7.
Leaving the roadmap unchanged would make the code and the authoritative plan disagree.

## Decision

`release:list` and `release:view` are catalogued, read-only actions. They request
`contents: read` and cannot publish, edit, upload or delete anything.

The hard deny is narrowed to the write side:

- `release create`
- `release edit`
- `release upload`
- `release download`
- `release delete`

## Why

Reading releases is the same permission and risk class as reading repository
contents, which the catalog already allows. Publishing a release creates or replaces
an artifact outside the pull-request lifecycle, so it stays denied until there is a
separate decision for it.

## Consequences

- The generated permission table continues to be the source of truth for the
  action permissions.
- Any future release write action needs a new decision and roadmap update; it is not
  opened by this note.
