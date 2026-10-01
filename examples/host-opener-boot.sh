#!/bin/sh
# Start the host-side opener at boot, on a host without user services (a Synology NAS, for instance).
#
# COPY THIS FILE SOMEWHERE OUTSIDE THE MOUNTS BEFORE A TASK RUNS IT. It runs as you, so leaving it in
# the checkout means anything that can write the checkout — an agent with this repository mounted —
# decides what your credentials do at boot. /usr/local/bin is a fine place; the file below it is the
# one that matters.
# The CLI is assumed to be installed globally: npm i -g git-credential-broker
#
# DSM: Control Panel → Task Scheduler → Create → Triggered Task → Boot-up
#   User:     the user whose GitHub credentials should author the pull requests — *not* root, which
#             has neither that user's gh login nor that user's home.
#   Command:  sh /usr/local/bin/host-opener-boot.sh        (the copy you made above)
#
# Settable from the outside, because a boot task gets a minimal environment:
#
#   GIT_BROKER_ROOT=/volume1/homes/<you>
#                                    the tree to serve: the parent of every checkout the container
#                                    sees. Not the default $HOME — under a boot task that is often
#                                    /var/services/homes/<you>, which is not that tree.
#   GIT_BROKER_BIN=/usr/local/bin/git-credential-broker
#                                    where the CLI is, when it is not on the PATH below
#   GIT_BROKER_GH=/usr/local/bin/gh  where gh is, when it is not on that PATH
set -u

# Where a global install and its node usually live on such a host. Prepended, not replaced: a task
# may well have a PATH of its own worth keeping.
PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export PATH

BIN=${GIT_BROKER_BIN:-$(command -v git-credential-broker || true)}
GH=${GIT_BROKER_GH:-gh}
ROOT=${GIT_BROKER_ROOT:-$HOME}
LOG=${GIT_BROKER_OPENER_LOG:-$HOME/.git-credential-broker-opener.log}
PIDFILE=${GIT_BROKER_OPENER_PID:-$HOME/.git-credential-broker-opener.pid}

if [ "$(id -u)" = 0 ]; then
  echo "host-opener: run this as the user whose gh credentials should be used, not as root" >&2
  exit 1
fi
if [ ! -x "$BIN" ]; then
  echo "host-opener: no git-credential-broker at ${BIN:-<empty>} — npm i -g git-credential-broker, or set GIT_BROKER_BIN=…" >&2
  exit 1
fi

# One at a time. Two openers would race each other over the same requests and could each try to
# create the same pull request.
if [ -f "$PIDFILE" ]; then
  old=$(cat "$PIDFILE" 2>/dev/null)
  # /proc/<pid>/cmdline, not kill -0: a recycled pid owned by anyone makes kill -0 succeed, so the
  # opener silently never starts, and it fails with EPERM for another user's process, so the guard
  # does not fire and a second opener starts — the race the comment above is about.
  if [ -n "$old" ] && [ -r "/proc/$old/cmdline" ] && grep -qa 'host-opener' "/proc/$old/cmdline"; then
    echo "$(date) already running as pid $old" >>"$LOG"
    exit 0
  fi
  echo "$(date) removing the stale pidfile (pid ${old:-unknown})" >>"$LOG"
  rm -f "$PIDFILE"
fi
echo $ >"$PIDFILE"

# exec, so the pid in the file is the opener's own, and stopping it stops the opener.
exec "$BIN" host-opener \
  --root "$ROOT" \
  --command "$GH" \
  >>"$LOG" 2>&1
