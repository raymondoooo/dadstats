#!/usr/bin/env bash
# Starts one throwaway instance per TRUST_PROXY value and runs test/proxy-check.js against each.
#
# It needs its own containers because the thing under test is a boot-time setting: the number of
# proxy hops Express believes. Nothing an already-running instance exposes would reveal it, so
# the only honest check is to configure an instance and watch which requests share a rate-limit
# bucket.
#
# Data goes to a temp directory rather than a named volume so nothing survives the run.
set -uo pipefail

IMAGE="${IMAGE:-dadstats}"
PORT="${PORT:-3281}"
CPORT="${CPORT:-3211}"          # port inside the container
ADMIN_PW="${ADMIN_PASSWORD:-proxy-check-admin-pw}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA=""

cleanup() {
  docker rm -f proxycheck >/dev/null 2>&1
  [ -n "$DATA" ] && rm -rf "$DATA"
}
trap cleanup EXIT
cleanup

wait_up() { for _ in $(seq 1 30); do curl -sf "http://localhost:$PORT/api/health" >/dev/null && return 0; sleep 1; done; return 1; }

run_phase() {
  local hops="$1" phase="$2"
  docker rm -f proxycheck >/dev/null 2>&1
  [ -n "$DATA" ] && rm -rf "$DATA"
  DATA="$(mktemp -d)"
  docker run -d --name proxycheck -p "$PORT:$CPORT" \
    -e ADMIN_PASSWORD="$ADMIN_PW" \
    -e TRUST_PROXY="$hops" \
    -v "$DATA:/app/data" "$IMAGE" >/dev/null || { echo "  FAIL  could not start with TRUST_PROXY=$hops"; return 1; }
  wait_up || { echo "  FAIL  instance with TRUST_PROXY=$hops never became healthy"; docker logs proxycheck; return 1; }
  APP_URL="http://localhost:$PORT" ADMIN_PASSWORD="$ADMIN_PW" node "$HERE/proxy-check.js" "$phase"
}

status=0
run_phase 1 one || status=1
run_phase 2 two || status=1

echo
if [ "$status" -eq 0 ]; then echo "PASS"; else echo "FAIL"; fi
exit "$status"
