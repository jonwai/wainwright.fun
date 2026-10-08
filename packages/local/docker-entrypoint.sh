#!/bin/sh
# Starts as root only to hand the profile signing files (root-only 0600 secret mounts, as on the
# Mac) to the node user, in memory (/run/profile-signing is a tmpfs), then runs as node.
set -eu
if [ "$(id -u)" = 0 ]; then
  if [ -r /run/secrets/profile_signing_cert ] && [ -r /run/secrets/profile_signing_key ] && [ -d /run/profile-signing ]; then
    install -o node -g node -m 0400 /run/secrets/profile_signing_cert /run/profile-signing/cert.pem
    install -o node -g node -m 0400 /run/secrets/profile_signing_key /run/profile-signing/key.pem
  fi
  chown node:node /data/ticket-icons
  exec su-exec node "$0" "$@"
fi
# Photos as in the hosted site bucket, without overwriting uploads.
cp -n /app/seed-icons/* /data/ticket-icons/ 2>/dev/null || true
exec node dist/main.mjs
