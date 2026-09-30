#!/usr/bin/env bash
#
# Deploy the broker as a Docker sidecar on the NAS.
#
# Run this ON THE HOST, in an SSH session as your normal user (not as root, not inside a
# container). It stages the key, config and code outside every container mount, builds the
# code in a throwaway container, and starts a sidecar that holds the private key.
#
# Why a sidecar rather than a host process: the host may not have Node, while Docker is
# definitely present. Why the code is copied and rebuilt rather than run in place: the broker
# reads the private key, so it must not execute code from ~/Workspaces, which the agent can
# write to. The script refuses to stage a dirty working tree for exactly that reason.
#
# After it finishes, the DSH container needs no change and no restart: the socket appears in
# the already-mounted ~/.dsh directory, at the path its git config already points to.
#
# Usage:
#   bash scripts/deploy-sidecar.sh
#   bash scripts/deploy-sidecar.sh --cert /path/to/key.pem --allow owner/repo,owner/*
#   bash scripts/deploy-sidecar.sh --dry-run          # print the plan, change nothing
set -euo pipefail

# ---------------------------------------------------------------- defaults
CERT=''
BASE='/volume1/docker/git-cred-broker'
APP_DIR="$BASE/app"
SOCKET_DIR=''
CLIENT_ID='Iv23lifamTDN4XTLvLuk'
APP_ID='5138420'
PERMISSIONS='contents=write'
ALLOW=()
DRY_RUN=0
ALLOW_DIRTY=0
SKIP_BUILD=0
NODE_IMAGE='node:24-slim'
CONTAINER_NAME='git-cred-broker'

say() { printf 'deploy: %s\n' "$1"; }
warn() { printf 'deploy: warning: %s\n' "$1" >&2; }
fail() { printf 'deploy: error: %s\n' "$1" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --cert) CERT="${2:-}"; shift 2 ;;
    --cert=*) CERT="${1#*=}"; shift ;;
    --base) BASE="${2:-}"; APP_DIR="${2:-}/app"; shift 2 ;;
    --base=*) BASE="${1#*=}"; APP_DIR="$BASE/app"; shift ;;
    --socket-dir) SOCKET_DIR="${2:-}"; shift 2 ;;
    --socket-dir=*) SOCKET_DIR="${1#*=}"; shift ;;
    --allow) IFS=',' read -r -a _new <<< "${2:-}"; ALLOW+=("${_new[@]}"); shift 2 ;;
    --allow=*) IFS=',' read -r -a _new <<< "${1#*=}"; ALLOW+=("${_new[@]}"); shift ;;
    --permissions) PERMISSIONS="${2:-}"; shift 2 ;;
    --permissions=*) PERMISSIONS="${1#*=}"; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
done
[ -n "$CERT" ] || fail "--cert is required (e.g. --cert /volume1/public/certificates/<name>.private-key.pem)"
[ "${#ALLOW[@]}" -gt 0 ] || fail "at least one --allow owner/repo is required (the broker is default-deny)"

# ---------------------------------------------------------------- guards
if [ -d /home/app/Workspaces ] && [ ! -d /volume1 ]; then
  fail "this looks like the DSH container. The broker must run outside it; run this on the NAS."
fi

[ -f "$CERT" ] || fail "no such file: $CERT"
grep -q 'PRIVATE KEY' "$CERT" || fail "$CERT does not look like a PEM private key"

# The key must not live inside a path the container can read.
case "$(cd "$(dirname "$CERT")" && pwd)/$(basename "$CERT")" in
  "$HOME/Workspaces"/*|"$HOME/.dsh"/*|"$HOME/.dotfiles"/*)
    fail "$CERT is inside a path mounted into the container; move it out first" ;;
esac

# Locate the project, and refuse to guess. The staging step copies this tree into a directory
# that will run with the private key, so a wrong $0 (a copy invoked from somewhere else) must
# fail loudly instead of sweeping an unrelated or enormous tree into place.
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SOURCE_DIR/package.json" ] || fail "no package.json in $SOURCE_DIR — run the script from the repository"
[ -f "$SOURCE_DIR/src/cli/daemon.ts" ] || fail "$SOURCE_DIR does not look like git-credential-broker (src/cli/daemon.ts is missing)"

# The repository copy must be clean: it is about to become code that runs with the key.
if [ -d "$SOURCE_DIR/.git" ]; then
  dirty="$(git -C "$SOURCE_DIR" status --porcelain)"
  if [ -n "$dirty" ]; then
    if [ "$ALLOW_DIRTY" = "1" ]; then
      warn "the working tree is dirty; deploying it anyway because --allow-dirty was given"
    elif [ "$DRY_RUN" = "1" ]; then
      # A dry run changes nothing, so it is the wrong moment to refuse: show the plan and say
      # what a real run would do.
      warn "the working tree is dirty; a real run would refuse. Pass --allow-dirty to accept it."
    else
      printf '%s\n' "$dirty" >&2
      fail "the working tree has uncommitted changes. The broker will run this code with the private key, so it must be code you reviewed: commit it, or pass --allow-dirty"
    fi
  fi
else
  warn "$SOURCE_DIR is not a git checkout, so the deployed code cannot be traced to a commit"
fi

# The socket directory must already be mounted into the DSH container, otherwise the container
# can never reach the broker. Derived from the compose mapping ./.dsh:/home/app/.dsh.
[ -n "$SOCKET_DIR" ] || SOCKET_DIR="$HOME/Workspaces/my-project/.dsh/git-broker"
[ -d "$(dirname "$SOCKET_DIR")" ] || fail "$(dirname "$SOCKET_DIR") does not exist; the container mounts ~/Workspaces/my-project/.dsh, so the socket must live below it"

# The sidecar must run as the same uid as the DSH container or it cannot connect to the socket.
# The container is started with PUID=${UID}, and this user owns the workspace.
OWNER="$(stat -c '%u:%g' "$HOME/Workspaces")"
case "$OWNER" in
  ''|*[!0-9:]*) fail "could not determine the workspace owner from $HOME/Workspaces" ;;
esac
CONTAINER_OWNER="$OWNER"

# ---------------------------------------------------------------- plan
say "certificate    : $CERT"
say "install root   : $BASE"
say "code           : $SOURCE_DIR -> $APP_DIR"
say "socket         : $SOCKET_DIR/broker.sock  (container: /home/app/.dsh/git-broker/broker.sock)"
say "runs as        : uid:gid $CONTAINER_OWNER (same as the DSH container)"
say "allowed repos  : ${ALLOW[*]}"
say "permissions    : $PERMISSIONS"
if [ -d "$SOURCE_DIR/.git" ]; then
  say "commit         : $(git -C "$SOURCE_DIR" rev-parse --short HEAD) $(git -C "$SOURCE_DIR" log -1 --pretty=%s)"
fi
[ "$DRY_RUN" = "1" ] || say "proceeding"

# ---------------------------------------------------------------- stage
run mkdir -p "$BASE" "$APP_DIR" "$BASE/log" "$SOCKET_DIR"
run chmod 700 "$SOCKET_DIR"

if [ "$DRY_RUN" = "0" ]; then
  install -m 600 "$CERT" "$BASE/app.pem"
  chown "$CONTAINER_OWNER" "$BASE/app.pem" 2>/dev/null || true
  chmod 600 "$BASE/app.pem"
  # The sidecar writes the audit log here as the same uid.
  chown "$CONTAINER_OWNER" "$BASE/log" 2>/dev/null || true
fi
say "installed key  : $BASE/app.pem (mode 600)"

# Copy the source, excluding things that must not run and need not ship. `dist` is included so
# a --skip-build deploy is possible, but a fresh build is done below by default.
if [ "$DRY_RUN" = "0" ]; then
  tar -C "$SOURCE_DIR" \
    --exclude='./node_modules' --exclude='./.git' --exclude='./.agents' \
    --exclude='./.yarn' --exclude='*.pem' --exclude='*.key' \
    -cf - . | tar -C "$APP_DIR" -xf -
  say "staged code    : $(find "$APP_DIR" -type f | wc -l) files"
fi

# ---------------------------------------------------------------- build (in a container, so the host needs no Node)
if [ "$SKIP_BUILD" = "1" ]; then
  say "build          : skipped (--skip-build); using the dist/ that was copied"
else
  say "build          : corepack yarn install && yarn build, in $NODE_IMAGE"
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] docker run --rm -v %s:/app -w /app %s sh -c "corepack enable && corepack yarn install --immutable && corepack yarn build"\n' "$APP_DIR" "$NODE_IMAGE"
  else
    command -v docker >/dev/null 2>&1 || fail "docker not found (needed to build and to run the sidecar)"
    docker run --rm -v "$APP_DIR":/app -w /app "$NODE_IMAGE" \
      sh -c 'corepack enable >/dev/null 2>&1 || true; corepack yarn install --immutable && corepack yarn build' \
      || fail "the build failed; fix it before the broker can start"
  fi
fi

# ---------------------------------------------------------------- config
allow_json=''
for entry in "${ALLOW[@]}"; do
  [ -n "$entry" ] || continue
  allow_json="${allow_json}${allow_json:+, }\"${entry}\""
done

perms_json=''
IFS=',' read -r -a perm_pairs <<< "$PERMISSIONS"
for pair in "${perm_pairs[@]}"; do
  [ -n "$pair" ] || continue
  name="${pair%%=*}"
  level="${pair#*=}"
  [ "$name" != "$pair" ] || fail "--permissions expects name=level pairs, got '$pair'"
  perms_json="${perms_json}${perms_json:+, }\"${name}\": \"${level}\""
done

if [ "$DRY_RUN" = "0" ]; then
  umask 077
  cat > "$BASE/config.json" <<EOF
{
  "socketPath": "/run/git-broker/broker.sock",
  "socketMode": 432,
  "auditPath": "/var/log/git-cred-broker/audit.jsonl",
  "tokenCacheSkewSeconds": 300,
  "hosts": {
    "github.com": {
      "provider": "github-app",
      "clientId": "$CLIENT_ID",
      "appId": $APP_ID,
      "privateKeyPath": "/etc/git-cred-broker/app.pem",
      "permissions": { $perms_json },
      "allow": [ $allow_json ]
    }
  }
}
EOF
  chmod 600 "$BASE/config.json"
fi
say "wrote config   : $BASE/config.json (mode 600; references the key by container path)"

# ---------------------------------------------------------------- compose
COMPOSE="$BASE/docker-compose.broker.yml"
if [ "$DRY_RUN" = "0" ]; then
  cat > "$COMPOSE" <<EOF
# Generated by git-credential-broker scripts/deploy-sidecar.sh
#
# The broker holds the only long-lived secret, so it runs in its own container with the key
# mounted read-only, no ports, no capabilities, and a read-only root filesystem. The only
# shared surface with the DSH container is the socket directory.
services:
  $CONTAINER_NAME:
    image: $NODE_IMAGE
    container_name: $CONTAINER_NAME
    restart: unless-stopped
    user: "$CONTAINER_OWNER"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    command: ["node", "/app/dist/cli/daemon.js", "--config", "/etc/git-cred-broker/config.json"]
    volumes:
      - $APP_DIR:/app:ro
      - $BASE/config.json:/etc/git-cred-broker/config.json:ro
      - $BASE/app.pem:/etc/git-cred-broker/app.pem:ro
      - $BASE/log:/var/log/git-cred-broker
      - $SOCKET_DIR:/run/git-broker
EOF
  say "wrote compose  : $COMPOSE"
fi

# ---------------------------------------------------------------- start
if [ "$DRY_RUN" = "0" ]; then
  command -v docker >/dev/null 2>&1 || fail "docker not found (needed to build and to run the sidecar)"
fi
say "starting       : docker compose -f $COMPOSE up -d"
run docker compose -f "$COMPOSE" up -d

# ---------------------------------------------------------------- verify
if [ "$DRY_RUN" = "1" ]; then
  say "dry run complete; nothing was changed"
  exit 0
fi

say "waiting for the socket"
for _ in $(seq 1 40); do
  [ -S "$SOCKET_DIR/broker.sock" ] && break
  sleep 0.5
done
if [ ! -S "$SOCKET_DIR/broker.sock" ]; then
  printf '\n' >&2
  docker compose -f "$COMPOSE" logs --tail 30 >&2 || true
  fail "no socket appeared at $SOCKET_DIR/broker.sock"
fi
say "socket is live : $SOCKET_DIR/broker.sock"

say "broker log:"
docker compose -f "$COMPOSE" logs --tail 5 2>&1 | sed 's/^/  /' || true

cat <<EOF

deploy: done. The DSH container needs no change and no restart.

deploy: verify from inside the DSH container:
  node scripts/probe.ts --socket /home/app/.dsh/git-broker/broker.sock \\
    --host github.com --repo <owner/repo>

deploy: then a push works as usual:
  git push

deploy: operate it with:
  docker compose -f $COMPOSE logs -f
  docker compose -f $COMPOSE restart      # after editing $BASE/config.json
  docker compose -f $COMPOSE down

deploy: after confirming it works, delete the key from any shared or public location
deploy: (for example /volume1/public/certificates/) and revoke every older key in the
deploy: GitHub App settings: the broker only needs $BASE/app.pem.
EOF
