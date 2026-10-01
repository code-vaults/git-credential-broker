# TASK — anchor a review comment to a file and a line

Status: built, deployed, and verified live on #4 (`src/commands/pr.ts:239`, thread
PRRT_kwDOU1uEcc6n4lyf). Two things it asked for are still open, recorded at the end.
Written: 2026-10-01
Depends on: nothing; the permission is already in place

## Why now

`pr --comment` can only post a review **body**. When an agent wants to say something
about one line of a diff, GitHub calls that a *review comment*, and today the broker has
no way to name the file or the line.

The case that produced this task: `devockr/deepseek-harness#4` pins
`FROM node:24-bookworm-slim` to a digest, and the agent added a marker line so the digest
stays readable:

```dockerfile
#v24.21.0
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
```

The explanation for that marker belongs **on line 4 of the diff**, next to the thing it
explains. Instead it went out as a review body
([pullrequestreview-5377111227](https://github.com/devockr/deepseek-harness/pull/4#pullrequestreview-5377111227)),
which reads as a general remark on the pull request.

## What exists today (verified against this checkout)

The pieces and the exact gap:

| Layer | Where | Today |
|---|---|---|
| CLI | `src/commands/pr.ts` — usage line 48, `actionOf()` 71-81, booleans 91, request built ~207-227 | `--comment` takes only `--body` / `--body-file` |
| Protocol | `src/commands/pr.ts` ~207-227; validated in `src/broker.ts` 264-344 | message carries `path` — but that is the **repository** path (`owner/name`) — plus `number`, `commentId`, `threadId`, `head`, `base`, `title`, `body`, `method`, `draft`. No file path, no line, no side |
| Provider | `src/providers/github-app.ts` 826-834 | `POST {collection}/{number}/reviews` with `{ body, event: 'COMMENT' }` |
| Types | `src/types.ts` ~85-100 (`PullRequestRequest`), ~200 (protocol message) | no line fields |

The line-aware actions that *do* exist are `--threads`, `--reply-to <commentId>` and
`--resolve <threadId>` (`github-app.ts` 754, 766). All three act on a thread that already
exists — nothing can create the first inline comment. On a pull request with no review
threads yet, `pr --threads` answers "no review threads on this pull request", so
`--reply-to` has nothing to attach to.

## The permission is not the problem

Do **not** fix this by granting the git credential more scope. The split is deliberate
and is three constants in `src/providers/github-app.ts`:

- line 156 — `cfg.permissions ?? { contents: 'write' }`: the credential **git** uses
- line 169 — `LOG_PERMISSIONS = { actions: 'read' }`: log reads, their own token
- line 179 — `PULL_REQUEST_PERMISSIONS = { pull_requests: 'write', contents: 'read' }`:
  what the `pr` flow mints at line 631

Posting an inline comment needs exactly `pull_requests: write`, which that third token
already has. GitHub confirms the requirement in a header rather than the body —
`POST /repos/{owner}/{repo}/pulls/{n}/comments` answers a scope-less caller with
`403` and `x-accepted-github-permissions: pull_requests=write`.

A note for whoever implements this: the reason `pr --comment` uses the reviews endpoint
at all is written at `github-app.ts` 827-829 — a *conversation* comment is the issues API,
which needs `issues: write`, which `PULL_REQUEST_PERMISSIONS` does not ask for. Keep that
shape; inline comments ride on the same `pull_requests: write` grant.

## GitHub API facts to build on

- `POST /repos/{owner}/{repo}/pulls/{number}/comments` with
  `{ body, commit_id, path, line, side }` — one inline comment.
- `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with
  `{ body?, event: 'COMMENT', comments: [{ path, line, side, body }] }` — a review that
  may contain inline comments. Preferred here: it is the call the broker already makes,
  so the existing body-only path stays one code path.
- `path` is repository-relative, no leading `/`.
- `line` is the line number in the **new** file for `side: 'RIGHT'`, and in the old file
  for `side: 'LEFT'`. A line that is not part of a hunk in the diff is a `422`.
- Multi-line ranges use `start_line` + `start_side`; treat as an optional stretch.

## Proposed change

1. **CLI** (`src/commands/pr.ts`): `--file <path>`, `--line <n>`, `--side <left|right>`
   (default `right`). Valid only together with `--comment`. `--file` without `--line` (or
   the reverse) is a usage error, refused before anything reaches the socket. Keep the
   existing "a comment has to say something" check at line 156.
2. **Protocol**: carry `filePath`, `line`, `side` on the `op: 'pull-request'` message.
3. **Broker** (`src/broker.ts` 264-344): validate them in the existing style — a refusal
   names the field and never explains internals (`deny(context, CODES.BAD_REQUEST, …)`):
   - `filePath`: non-empty string, no leading `/`, no `..` segment, length bounded
   - `line`: positive integer
   - `side`: `left` or `right`
   - reject any of the three when `action !== 'comment'`
4. **Provider** (`src/providers/github-app.ts` 826-834): when a file and line are given,
   add `comments: [{ path, line, side, body }]` to the same reviews `POST`; otherwise send
   today's `{ body, event: 'COMMENT' }` unchanged.
5. **Types** (`src/types.ts`): extend `PullRequestRequest` and the protocol message.
6. **Docs**: the `pr --comment` line in `PR_USAGE` (line 48) and the README section on `pr`.
7. **Nice to have**: have `--threads` print the `path` and `line` of each thread (it
   already reads them at `github-app.ts` 766) so a caller can pick a thread to reply to.

## Acceptance criteria

- `pr --number N --comment --file Dockerfile --line 4 --body '…'` shows up as a comment on
  that line in the pull request's *Files changed* view. For the live case above the payload
  is `path: 'Dockerfile'`, `line: 4`, `side: 'RIGHT'`,
  `commit_id: 00c01235e7c85f60e538ad67296a870dacfa80c2` (line 5 is the `FROM` line, if the
  anchor is wanted there instead).
- A body-only `--comment` behaves exactly as before — this must stay backward compatible.
- `--file`/`--line` on `open`, `merge`, `close`, `status`, `update`, `threads`, `reply` or
  `resolve` is refused with a clear message.
- A path that is absolute, contains `..`, or is empty is refused by the broker, not by
  GitHub.
- A line that is not in the diff surfaces GitHub's `422` as a caller-readable refusal
  rather than a raw error.

## Tests

- `test/unit/broker.test.ts` — the fake provider at lines 236, 286 and 315 is where the
  validation matrix belongs: good `{ filePath, line, side }`, each field bad, each field
  with the wrong action.
- `test/unit/github-app.test.ts` — the provider test around line 500 already drives
  `pullRequest`; assert the reviews `POST` body contains `comments: [{ path, line, side,
  body }]`. Nothing asserts the current comment payload today, so that is a gap worth
  closing at the same time.
- `test/unit/commands.test.ts` — CLI-level: `--file` without `--line` and the reverse.
- `yarn test:unit` (typecheck is separate: `yarn typecheck`).

## Deployment note

The running broker is outside the agent's container. The container only mounts the socket
(`/home/app/.dsh/git-broker/broker.sock`), and no `git-credential-brokerd` appears in its
PID namespace — PID 1 there is `dsh`. So a source change here does nothing until the
operator re-stages and restarts the broker (`init`/`stage`, then restart the sidecar or the
host daemon). Until that happens, `pr --comment` keeps posting a body-only review.

## Out of scope

- Widening the git credential to `pull_requests: write`. Explicitly not the fix.
- Conversation (issues) comments: they need `issues: write` and a decision about whether
  the broker should hold it at all.
- Deleting or superseding an existing review. There is no action for that today, so the
  interim body-only review on `#4` has to be removed in the UI by a person.

## What is still open, from this task

- **GitHub's 422 says nothing, even in the host log.** `callWithToken` reports the status and not the body,
  so a line that is not in the diff is a refusal nobody can act on. It is the criterion "surfaces GitHub's
  422 as a caller-readable refusal" only on the generous reading: the caller gets a refusal code, and the
  operator gets nothing. The fix belongs where the scope check learned to be honest: carry the response
  body for a failure that is not a `ProviderConfigError`, so it reaches the host log and not the caller.
- **No CLI-level tests.** `--file` without `--line`, the reverse, an anchor on another action and a bad
  `--side` are all checked in the CLI, and all four were exercised by hand against the live broker —
  including the empty-`--line` case the shell produced by accident. The recommendation asks for them in
  `test/unit/commands.test.ts`; they need a subprocess because `fail` exits the process.
