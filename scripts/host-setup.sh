#!/usr/bin/env bash
#
# HOST-side setup: install the GitHub App private key and generate the broker configuration.
#
# Run this ON THE HOST (the NAS), never inside the container. It does the mechanical parts of
# the setup so the only things left to a human are the two that genuinely require a browser:
# downloading the private key, and installing the app on the target repositories.
#
#   bash scripts/host-setup.sh \
#     --app-pem ~/Downloads/git-credential-broker.2026-09-30.private-key.pem \
#     --allow code-vaults/git-credential-broker
#
# Then start the broker (see the printed instructions, or examples/docker-compose.snippet.yml).
set -euo pipefail

# ---------------------------------------------------------------- defaults
CLIENT_ID='Iv23lifamTDN4XTLvLuk'
APP_ID='5138420'
DIR='/volume1/docker/git-cred-broker'
PERMISSIONS='contents=write'
APP_PEM=''
ALLOW=()
FORCE=0

# The default socket path deliberately lands under the container-visible ~/.dsh mount, so the
# container reaches it with no compose change and no restart. See --socket-path to override.
SOCKET_PATH="${HOME}/Workspaces/my-project/.dsh/git-broker/broker.sock"
CONTAINER_SOCKET='/home/app/.dsh/git-broker/broker.sock'

say() { printf 'host-setup: %s\n' "$1"; }
fail() { printf 'host-setup: error: %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --app-pem) APP_PEM="${2:-}"; shift 2 ;;
    --app-pem=*) APP_PEM="${1#*=}"; shift ;;
    --allow) IFS=',' read -r -a _new <<< "${2:-}"; ALLOW+=("${_new[@]}"); shift 2 ;;
    --allow=*) IFS=',' read -r -a _new <<< "${1#*=}"; ALLOW+=("${_new[@]}"); shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --socket-path) SOCKET_PATH="${2:-}"; shift 2 ;;
    --socket-path=*) SOCKET_PATH="${1#*=}"; shift ;;
    --client-id) CLIENT_ID="${2:-}"; shift 2 ;;
    --client-id=*) CLIENT_ID="${1#*=}"; shift ;;
    --app-id) APP_ID="${2:-}"; shift 2 ;;
    --app-id=*) APP_ID="${1#*=}"; shift ;;
    --permissions) PERMISSIONS="${2:-}"; shift 2 ;;
    --permissions=*) PERMISSIONS="${1#*=}"; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- guard rails
if [ -d /home/app/Workspaces ] && [ ! -d /volume1 ]; then
  fail "this looks like the DSH container, not the host (no /volume1). The broker must run outside the container; run this on the NAS."
fi

[ -n "$APP_PEM" ] || fail "--app-pem is required (the .pem GitHub gave you)"
[ -f "$APP_PEM" ] || fail "no such file: $APP_PEM"
grep -q 'PRIVATE KEY' "$APP_PEM" || fail "$APP_PEM does not look like a PEM private key"

[ "${#ALLOW[@]}" -gt 0 ] || fail "at least one --allow owner/repo is required (the broker is default-deny)"

# The private key must not live anywhere the container can read.
case "$DIR" in
  "$HOME/Workspaces"|"$HOME/Workspaces"/*) fail "$DIR is inside ~/Workspaces, which is mounted into the container" ;;
  "$HOME/.dsh"|"$HOME/.dsh"/*) fail "$DIR is inside ~/.dsh, which is mounted into the container" ;;
  "$HOME/.dotfiles"|"$HOME/.dotfiles"/*) fail "$DIR is inside ~/.dotfiles, which is mounted into the container" ;;
esac

CONFIG="$DIR/config.json"
if [ -f "$CONFIG" ] && [ "$FORCE" != "1" ]; then
  fail "$CONFIG already exists; pass --force to overwrite it"
fi

# ---------------------------------------------------------------- build the JSON
allow_json=''
for entry in "${ALLOW[@]}"; do
  [ -n "$entry" ] || continue
  allow_json="${allow_json}${allow_json:+, }\"${entry}\""
done
[ -n "$allow_json" ] || fail "no usable --allow entries"

perms_json=''
IFS=',' read -r -a perm_pairs <<< "$PERMISSIONS"
for pair in "${perm_pairs[@]}"; do
  [ -n "$pair" ] || continue
  name="${pair%%=*}"
  level="${pair#*=}"
  [ "$name" != "$pair" ] || fail "--permissions expects name=level pairs, got '$pair'"
  perms_json="${perms_json}${perms_json:+, }\"${name}\": \"${level}\""
done

# ---------------------------------------------------------------- install
umask 077
mkdir -p "$DIR"
cp "$APP_PEM" "$DIR/app.pem"
chmod 600 "$DIR/app.pem"

cat > "$CONFIG" <<EOF
{
  "socketPath": "$SOCKET_PATH",
  "socketMode": 432,
  "auditPath": "$DIR/audit.jsonl",
  "tokenCacheSkewSeconds": 300,
  "hosts": {
    "github.com": {
      "provider": "github-app",
      "clientId": "$CLIENT_ID",
      "appId": $APP_ID,
      "privateKeyPath": "$DIR/app.pem",
      "permissions": { $perms_json },
      "allow": [ $allow_json ]
    }
  }
}
EOF
chmod 600 "$CONFIG"

say "installed key  : $DIR/app.pem (mode 600)"
say "wrote config   : $CONFIG (mode 600)"
say "allowed repos  : ${ALLOW[*]}"

# ---------------------------------------------------------------- validate offline
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if command -v node >/dev/null 2>&1 && [ -f "$ROOT/dist/cli/daemon.js" ]; then
  say "validating configuration (offline: reads the key, binds nothing)"
  node "$ROOT/dist/cli/daemon.js" --config "$CONFIG" --check
else
  say "skipped validation: build first with 'corepack yarn install && corepack yarn build' in $ROOT,"
  say "  then run: node $ROOT/dist/cli/daemon.js --config $CONFIG --check"
fi

# ---------------------------------------------------------------- what is left
cat <<EOF

host-setup: two things only you can do:
  1. Install the app on the account that owns the repositories, granting access to just the
     repositories listed above:  https://github.com/apps/git-credential-broker/installations/new
     If the app is not Public and is owned by an organisation, it can only be installed on that
     organisation's account.
  2. Confirm the app's granted permissions cover the ones requested above. The broker checks
     this on first use and names anything missing.

host-setup: then start the broker:
  node $ROOT/dist/cli/daemon.js --config $CONFIG

host-setup: inside the container, point the helper at the same socket:
  export GIT_BROKER_SOCKET=$CONTAINER_SOCKET
  export GIT_BROKER_REQUIRE=1
  bash scripts/container-setup.sh

host-setup: verify without pushing (prints a fingerprint, never the credential):
  node scripts/probe.ts --socket $CONTAINER_SOCKET --host github.com --repo <owner/repo>
EOF

if [ "$SOCKET_PATH" != "$CONTAINER_SOCKET" ]; then
  say "note: socketPath is $SOCKET_PATH; the container sees that path only if it is one of the"
  say "  mounted directories. Otherwise bind-mount its directory and set GIT_BROKER_SOCKET to"
  say "  the container-side path (see examples/docker-compose.snippet.yml)."
fi
