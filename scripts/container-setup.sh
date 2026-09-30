#!/usr/bin/env bash
#
# Container-side setup: teach this container's git to ask the broker for credentials.
#
# Run this INSIDE the container, as the uid that runs git. It writes only to the container's
# own git config, never to anything the host can see.
#
# Why the care about paths: `~/Workspaces` is a bind mount shared with the host, and the host
# pushes over SSH with its own credentials. Repository-local configuration (`.git/config`
# inside a workspace) is therefore shared, and the host's global config is the mounted
# `~/.dotfiles/gitconfig`. Writing credential settings into either place would change the
# host's git behaviour. The container's own `~/.gitconfig` is a separate, container-local
# file (`/home/app` is not a bind mount), so that is the only place we touch.
#
# Usage:
#   bash scripts/container-setup.sh                 # configure the container's global git config
#   GIT_BROKER_HELPER=/abs/path bash scripts/container-setup.sh
#   GIT_BROKER_REWRITE_SSH=0 bash scripts/container-setup.sh   # leave remote URLs alone
#
# Invoke it with `bash` explicitly: this workspace is on a btrfs share whose ACLs defeat git's
# executable-bit detection, so the exec bit is not tracked in this repository.
set -euo pipefail

HELPER="${GIT_BROKER_HELPER:-git-credential-broker}"
SOCKET="${GIT_BROKER_SOCKET:-/run/git-cred-broker/broker.sock}"
CONFIG="${GIT_BROKER_GITCONFIG:-$HOME/.gitconfig}"
ENV_FILE="${GIT_BROKER_ENV_FILE:-$HOME/.git-broker.env}"
SOCKET_FILE="${GIT_BROKER_SOCKET_FILE:-$HOME/.config/git-credential-broker/socket}"
REWRITE_SSH="${GIT_BROKER_REWRITE_SSH:-1}"

say() { printf 'container-setup: %s\n' "$1"; }
fail() { printf 'container-setup: error: %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is not installed"

# Refuse to write through a symlink. On the host, ~/.gitconfig is a symlink into ~/.dotfiles;
# if this container has the same layout, following it would edit the host's global git config.
if [ -L "$CONFIG" ]; then
  fail "$CONFIG is a symlink to $(readlink -f "$CONFIG" 2>/dev/null || readlink "$CONFIG"); refusing to write through it, because that would change the host's git config"
fi

resolved="$CONFIG"
if command -v readlink >/dev/null 2>&1; then
  resolved="$(readlink -f "$CONFIG" 2>/dev/null || printf '%s' "$CONFIG")"
fi
case "$resolved" in
  "$HOME/.dotfiles"/*)
    fail "$CONFIG resolves into $HOME/.dotfiles, which is the host's mounted dotfiles repository"
    ;;
esac

mkdir -p "$(dirname "$CONFIG")"

# A credential helper *plus* useHttpPath are both required. Without useHttpPath git sends no
# repository path to the helper, and the broker can only authorize at host granularity, so it
# refuses outright rather than over-granting.
git config --file "$CONFIG" credential.helper "$HELPER"
git config --file "$CONFIG" credential.useHttpPath true

# GitHub App installation tokens are HTTPS-only, and the container has no SSH key or agent
# (its ~/.ssh holds just known_hosts). Rewriting the SSH remote to HTTPS here makes the same
# `git push` work from inside the container while leaving the repository's shared .git/config
# — and therefore the host's SSH workflow — completely untouched.
if [ "$REWRITE_SSH" = "1" ]; then
  git config --file "$CONFIG" url."https://github.com/".insteadOf "git@github.com:"
fi

# TLS trust. git speaks HTTPS through libcurl, which needs a CA bundle *on disk*; this image
# installs git with --no-install-recommends and no ca-certificates, so /etc/ssl/certs does not
# exist and every https operation dies with
#   "server certificate verification failed. CAfile: none CRLfile: none"
# (Node is unaffected because it bundles its own trust store, which is why `fetch` works here
# while `git` does not.) Installing ca-certificates in the image is the right long-term fix;
# this makes the container work now, without a rebuild.
CA_BUNDLE="${GIT_BROKER_CA_BUNDLE:-$HOME/.config/git-credential-broker/ca-bundle.pem}"
if [ -f /etc/ssl/certs/ca-certificates.crt ] || [ -f /etc/ssl/cert.pem ]; then
  say "system CA bundle present; leaving git's TLS configuration alone"
elif command -v node >/dev/null 2>&1; then
  mkdir -p "$(dirname "$CA_BUNDLE")"
  node -e 'const {rootCertificates} = require("node:tls"); require("node:fs").writeFileSync(process.argv[1], rootCertificates.join("\n") + "\n");' "$CA_BUNDLE"
  chmod 644 "$CA_BUNDLE"
  git config --file "$CONFIG" http.sslCAInfo "$CA_BUNDLE"
  say "no system CA bundle: wrote one from Node's trust store and pointed git at it"
  say "  ($CA_BUNDLE — add 'ca-certificates' to the image to make this unnecessary)"
else
  say "warning: no CA bundle and no node available; https pushes will fail TLS verification"
fi

chmod 600 "$CONFIG"

# The socket path is per-process environment, not git configuration, so it is written to two
# places. The env file is for interactive shells; the socket file is the durable one, and the
# helper reads it when the environment carries nothing — git is often spawned from a non-login
# shell that never sources a profile, and "pushes silently stopped working" is a bad failure.
umask 077
cat > "$ENV_FILE" <<EOF
# Generated by git-credential-broker scripts/container-setup.sh
export GIT_BROKER_SOCKET='$SOCKET'
# Fail closed: if the socket variable ever goes missing, refuse rather than silently
# falling back to whatever other credential the environment happens to offer.
export GIT_BROKER_REQUIRE=1
EOF
chmod 600 "$ENV_FILE"

mkdir -p "$(dirname "$SOCKET_FILE")"
printf '%s\n' "$SOCKET" > "$SOCKET_FILE"
chmod 600 "$SOCKET_FILE"

say "wrote $CONFIG (mode 600):"
git config --file "$CONFIG" --list | sed 's/^/  /'
say "wrote $ENV_FILE and $SOCKET_FILE; add \`source $ENV_FILE\` to your shell, or set these in compose:"
say "  GIT_BROKER_SOCKET=$SOCKET"
say "  GIT_BROKER_REQUIRE=1"

if ! command -v "$HELPER" >/dev/null 2>&1; then
  say "note: '$HELPER' is not on PATH yet; point GIT_BROKER_HELPER at the installed entry point"
fi

if [ ! -S "$SOCKET" ]; then
  say "note: no broker socket at $SOCKET yet; pushes will fail closed until the broker runs"
fi
