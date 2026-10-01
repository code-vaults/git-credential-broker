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

## Open

Everything this note listed has since been fixed, in the commits that followed it; the dispositions it
described are no longer what the branch does, so the list is gone rather than corrected line by line. The
pre-merge review that replaced it found the blockers in the compose render, the `gitdir:` pointer and the
marker reader, and those are fixed too.
