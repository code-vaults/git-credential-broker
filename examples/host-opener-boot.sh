#!/bin/sh
# Start the host-side opener at boot, on a host without user services (a Synology NAS, for instance).
#
# DSM: Control Panel → Task Scheduler → Create → Triggered Task → Boot-up
#   User:     the user whose GitHub credentials should author the pull requests — *not* root, which
#             has neither that user's gh login nor that user's home.
#   Command:  sh /volume1/homes/<you>/Workspaces/<checkout>/examples/host-opener-boot.sh
#
# A boot task gets a minimal environment, so everything below is settable from the outside, and the
# two programs are looked up rather than assumed. Set CHECKOUT at the very least; the rest have
# defaults that are usually right once CHECKOUT is:
#
#   CHECKOUT=/volume1/homes/<you>/Workspaces/<checkout>
#                                    the checkout the container also sees
#   GIT_BROKER_ROOT=/volume1/homes/<you>
#                                    the tree to serve: the parent of every checkout the container
#                                    sees. Not the default $HOME — under a boot task that is often
#                                    /var/services/homes/<you>, which is not that tree.
#   NODE=/usr/local/bin/node         command -v node, as that user
#   GH=/usr/local/bin/gh             command -v gh, as that user
set -u

CHECKOUT=${CHECKOUT:-/volume1/homes/<you>/Workspaces/<checkout>}
NODE=${NODE:-$(command -v node || true)}
GH=${GH:-$(command -v gh || true)}
ROOT=${GIT_BROKER_ROOT:-$(dirname "$(dirname "$CHECKOUT")")}
LOG=${GIT_BROKER_OPENER_LOG:-$HOME/.git-credential-broker-opener.log}
PIDFILE=${GIT_BROKER_OPENER_PID:-$HOME/.git-credential-broker-opener.pid}

if [ "$(id -u)" = 0 ]; then
  echo "host-opener: run this as the user whose gh credentials should be used, not as root" >&2
  exit 1
fi
if [ ! -x "$NODE" ]; then
  echo "host-opener: no node at ${NODE:-<empty>} — set NODE=… (command -v node)" >&2
  exit 1
fi
if [ ! -x "$GH" ]; then
  echo "host-opener: no gh at ${GH:-<empty>} — set GH=… (command -v gh, then gh auth login)" >&2
  exit 1
fi
if [ ! -f "$CHECKOUT/src/cli/helper.ts" ]; then
  echo "host-opener: no checkout at $CHECKOUT — set CHECKOUT=…" >&2
  exit 1
fi

# One at a time. Two openers would race each other over the same requests and could each try to
# create the same pull request.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  exit 0
fi
echo $$ >"$PIDFILE"

# exec, so the pid in the file is the opener's own, and stopping it stops the opener.
exec "$NODE" "$CHECKOUT/src/cli/helper.ts" host-opener \
  --root "$ROOT" \
  --command "$GH" \
  >>"$LOG" 2>&1
