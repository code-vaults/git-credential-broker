# Self-review of the pull-request branch

**Status: reviewed; the findings below are the ones still open at the time of the pre-merge review. Six of the
ones this note first listed were fixed afterwards and are named under "Open" below, because a list of what is left is
only useful if it is current.**

A branch that adds a channel between an agent-writable container and a host process running as a person
deserves an adversarial reading, so one was held: eight agents each read one area of the diff in full, and
a different agent per area then tried to falsify every finding, quoting the line that settled it. Sixteen
agents, fifty-five findings raised, twenty-five confirmed (seven high, eighteen medium), about thirty
rejected — the rejection pass is what makes the rest worth reading.

## Fixed here

1. **The channel is written by the container, so the opener must not trust it** (`d77bceb`).
   `writeJsonAtomic` wrote to a predictable temp name with a write that follows symlinks, so a symlink at
   `<id>.result.json.<pid>.tmp` made the opener truncate and overwrite an arbitrary host file — the private
   key and the refresh token included, the two paths kept outside every mount. `readJson` read whatever was
   there (a FIFO blocked the process forever with nothing in the log; a symlink read a host file), and
   `listRequests` filtered by name only. The write is exclusive now, the read takes `lstat` and a size, and
   the listing takes regular files. `removeRequest` and the rename also threw on a directory, which under
   `Restart=always` is a crash loop rather than one bad request.
2. **A request is claimed before it is acted on** (`0074a1f`). Reading it, creating the pull request and only
   then removing it left the window as long as `gh` takes, so a service and a hand-run `--once` could both
   act and create the pull request twice under the person's name. `claimRequest` renames atomically first.
3. **`authorize` keeps the token outside the mounts** (`c5ddb75`). `init` and `stage` both refuse a path
   inside the container or a mounted directory; `authorize` did not, though the same runbook says to run it
   from the deployment directory.
4. **A resolve checks whose thread it is** (`6d9d961`). The thread id is a global node id and the person's
   token is not narrowed to a repository the way an installation token is, so an allowlisted repository plus
   a thread id from another one would have resolved there, recorded against the approved repository.

## Open, in the order worth doing

(Six items this section had — the `--status` pre-flight missing `actions: read`, the refresh-token write-back
outside a try, `userTokens` keys not lower-cased, a `.git` directory accepted without a `HEAD`, the boot
wrapper's `kill -0` guard, and the documentation set — were fixed in the commits after this note was
written, along with two of the three paths that derive the refresh token. They are not repeated below.)

- **The two timeout constants disagree**: `pr` waits 60 s while the broker destroys an idle connection after
  30 s, so an action that takes longer is reported `unreachable` even though it completed — for `--merge` and
  `--close`, the operator is told a finished mutation failed. Same shape as the `fetch failed` message that
  cost an hour: the report and the fact differ.
- **`status` pre-flights `pull_requests` and then reads `/actions/runs`**, which needs `actions: read`. The
  pre-flight exists to name a missing permission; here it passes a grant that cannot make the second call.
- **A lost refresh token says nothing.** The write-back sits outside the try, so a read-only mount (the exact
  hazard the README names) throws a bare `EACCES` after GitHub has already invalidated the old token. It
  should say that re-authorizing is the only recovery.
- **`userTokens` keys are matched case-sensitively** while every other owner comparison is not, so a key
  spelled `An-Org` validates and then silently never matches — the pull request is created as the app, which
  is the outcome the option exists to prevent.
- **A `.git` file is trusted as a pointer.** `discoverCheckouts` publishes `channelDir` for any path such a
  file names, so the container can choose where the opener creates its channel (and, with `rmSync`, what it
  deletes there). It should be a candidate: a directory that looks like a git directory, nothing created.
- **The opener's identity comes from a checkout the container can write.** `gh` resolves the repository from
  the remote of `cwd`, and the container can rewrite `.git/config`. The comment says the checkout decides
  "so a request cannot aim the opener at another one", which is stronger than what is true. Either take the
  repository from operator configuration, or say what the checkout actually guarantees.
- **The boot wrapper's guard is `kill -0` on a pidfile it never removes**, wrong in both directions: a
  recycled pid of another user's process starts a second opener (the race the file's own comment describes),
  and a recycled pid of a live process makes the opener silently never start.
- **Documentation that is now wrong**: `compose` advises `init --mode sidecar --force`, which discards the
  file and demands the allowlist again, while a plain `init --mode sidecar` switches layout in place;
  `examples/docker-compose.snippet.yml` names `/run/git-cred-broker` where the sidecar records
  `/run/git-broker`; the README's host-side `authorize` example passes the sidecar's container path; a
  security warning in the README sits inside a ```sh fence; `AGENTS.md` says everything inside `hosts` is
  checked, but unknown keys there are dropped silently; the boot wrapper's own Command points at the copy
  inside the checkout while its header says to move it out.
- **Smaller, from the same pass**: `COMMANDS` is exported and unused, so the help text and the dispatch list
  are two lists; `test/unit/daemon.test.ts` deliberately passes no `--config`, which makes its outcome depend
  on the machine's `$HOME`; the `user.refresh` path is derived in four places, so the write side, the read
  side and the mount can drift; and the rule that checks for key material matches its own text in
  `AGENTS.md`, so it can never pass as written.
