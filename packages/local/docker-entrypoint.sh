#!/bin/sh
# Starts as root only to hand the profile signing files (root-only 0600 secret mounts, as on the
# Mac) to the node user, in memory (/run/profile-signing is a tmpfs), then runs as node.
set -eu
if [ "$(id -u)" = 0 ]; then
  if [ -r /run/secrets/profile_signing_cert ] && [ -r /run/secrets/profile_signing_key ] && [ -d /run/profile-signing ]; then
    install -o node -g node -m 0400 /run/secrets/profile_signing_cert /run/profile-signing/cert.pem
    install -o node -g node -m 0400 /run/secrets/profile_signing_key /run/profile-signing/key.pem
  fi
  # Homework tokens are often root-only 0600, same as the signing secrets. Copy them
  # where the node user can read them. Compose points HA_TOKEN_FILE at these copies.
  # Absent secrets are skipped, so a container without homework mode still starts.
  if [ -r /run/secrets/ha_token ] || [ -r /run/secrets/homework_domains_token ]; then
    mkdir -p /run/ha-tokens
    if [ -r /run/secrets/ha_token ]; then
      install -o node -g node -m 0400 /run/secrets/ha_token /run/ha-tokens/ha_token
    fi
    if [ -r /run/secrets/homework_domains_token ]; then
      install -o node -g node -m 0400 /run/secrets/homework_domains_token /run/ha-tokens/homework_domains_token
    fi
    chown node:node /run/ha-tokens
  fi
  chown node:node /data/ticket-icons
  # Launcher icons are fetched on save and by the admin backfill, so node must own them.
  mkdir -p /data/kids-icons/app-icons /data/kids-icons/website-icons
  chown -R node:node /data/kids-icons
  exec su-exec node "$0" "$@"
fi
# Photos as in the hosted site bucket, without overwriting uploads.
cp -n /app/seed-icons/* /data/ticket-icons/ 2>/dev/null || true
exec node dist/main.mjs
