#!/bin/sh
set -e

# Fix data-directory ownership at *runtime*, then drop privileges.
#
# Doing this with `RUN chown` at build time looks equivalent and isn't: a mount lands on top of
# /app/data and replaces whatever the image had there. When the host path doesn't exist yet,
# Docker creates it as root, the unprivileged app can't write, and the container dies with
# SQLITE_CANTOPEN before it ever serves a request. That is the single most common way a
# self-hosted install fails on first run, and the user has no way to guess why.
#
# So: start as root purely to chown the mounted path, then hand off to the app as `node`.
# `exec` matters — it replaces this shell, so node becomes PID 1 and receives SIGTERM directly
# instead of docker stop having to time out and kill it.
DATA_DIR="$(dirname "${SQLITE_PATH:-/app/data/dadstats.db}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only touches the data directory. A read-only or oddly-permissioned mount shouldn't be fatal
  # here — the app reports a clearer error than chown would.
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi

# Already unprivileged (e.g. `docker run --user`), so respect that and just run.
mkdir -p "$DATA_DIR" 2>/dev/null || true
exec "$@"
