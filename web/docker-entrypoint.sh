#!/bin/sh
# Starts as root only long enough to hand the Claude config volume to the bun
# user: a volume created by an image built with another APP_UID keeps its old
# owner, and bun could no longer read its sessions or credentials. Then drops
# to bun for the server and every Claude Code process it starts.
set -eu
if [ "$(id -u)" = 0 ]; then
  dir="${CLAUDE_CONFIG_DIR:-/home/bun/.claude}"
  mkdir -p "$dir"
  if [ "$(stat -c %u:%g "$dir")" != "$(id -u bun):$(id -g bun)" ]; then
    chown -R bun:bun "$dir"
  fi
  exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"
fi
exec "$@"
