#!/bin/sh
# Start the host-side opener at boot, on a host without user services (a Synology NAS, for instance).
#
# DSM: Control Panel → Task Scheduler → Create → Triggered Task → Boot-up
#   User:     *you*, not root — the opener creates pull requests with the credentials of the user it
#             runs as, and root has neither your gh login nor your home.
#   Command:  sh /volume1/homes/JounQin/Workspaces/git-credential-broker/examples/host-opener-boot.sh
#
# Everything here is an absolute path on purpose: a boot task gets a minimal environment, no PATH to
# speak of, and a HOME that is not the one you log in with. Run `command -v node gh` as yourself to
# check the two paths below.
set -u

CHECKOUT=${CHECKOUT:-/volume1/homes/JounQin/Workspaces/git-credential-broker}
NODE=${NODE:-/usr/local/bin/node}
GH=${GH:-/usr/local/bin/gh}
# The tree to serve: the parent of every checkout the container also sees. Not $HOME — under a boot
# task that is often /var/services/homes/<user> rather than /volume1/homes/<user>.
ROOT=${GIT_BROKER_ROOT:-/volume1/homes/JounQin}
LOG=${GIT_BROKER_OPENER_LOG:-/volume1/homes/JounQin/.git-credential-broker-opener.log}
PIDFILE=${GIT_BROKER_OPENER_PID:-/volume1/homes/JounQin/.git-credential-broker-opener.pid}

if [ ! -x "$NODE" ]; then
  echo "host-opener: no node at $NODE — set NODE=… (command -v node)" >&2
  exit 1
fi
if [ ! -x "$GH" ]; then
  echo "host-opener: no gh at $GH — set GH=… (command -v gh, then gh auth login)" >&2
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
