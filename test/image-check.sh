#!/usr/bin/env bash
# Image and runtime invariants. These are the properties that regress silently — nothing in the
# app's behaviour changes when the runtime image quietly gains a C compiler, or when a refactor
# starts the process as root, so they're asserted explicitly.
#
#   IMAGE=dadstats:ci ./test/image-check.sh
set -uo pipefail

IMAGE="${IMAGE:-dadstats}"
PORT="${PORT:-3251}"
NAME="dadstats-imgcheck"
VOLUME="dadstats-imgcheck-data"
BIND_DIR="${BIND_DIR:-/tmp/dadstats-bindcheck}"

fails=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm "$VOLUME" >/dev/null 2>&1
  rm -rf "$BIND_DIR"
}
trap cleanup EXIT
cleanup

wait_healthy() {  # container name, seconds
  for _ in $(seq 1 "$2"); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = "healthy" ] && return 0
    sleep 1
  done
  return 1
}

echo "== image =="

# A build toolchain in the runtime image is pure bloat shipped to every user forever, and it
# reappears the moment someone "fixes" a native-module build by editing the wrong stage.
if docker run --rm --entrypoint sh "$IMAGE" -c 'command -v gcc g++ make python3' >/dev/null 2>&1; then
  fail "runtime image contains a build toolchain"
else
  pass "no build toolchain in runtime image"
fi

# npm is deleted from the runtime stage (see Dockerfile). Nothing runs it — CMD is node directly,
# the healthcheck is `node -e`, the entrypoint is su-exec — but it vendors a dependency tree whose
# CVEs get reported against this image and can only be fixed by upstream Node shipping a newer
# npm. Every High and Critical in the published 0.8.0 image came from exactly that, and removing
# it took the report to zero. Asserted because a future edit to the runtime stage could restore it
# without anyone noticing until a scanner lights up months later.
if docker run --rm --entrypoint sh "$IMAGE" -c 'command -v npm npx' >/dev/null 2>&1; then
  fail "runtime image still ships npm (it vendors CVEs and nothing here runs it)"
else
  pass "npm is absent from the runtime image"
fi

for label in org.opencontainers.image.source org.opencontainers.image.licenses org.opencontainers.image.title; do
  if [ -n "$(docker image inspect "$IMAGE" --format "{{index .Config.Labels \"$label\"}}" 2>/dev/null)" ]; then
    pass "label $label"
  else
    fail "missing label $label"
  fi
done

echo "== runtime =="

docker run -d --name "$NAME" -p "$PORT:3211" -v "$VOLUME:/app/data" "$IMAGE" >/dev/null

if wait_healthy "$NAME" 45; then
  pass "healthcheck reaches healthy"
else
  fail "healthcheck never reached healthy (status: $(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null))"
  docker logs "$NAME" 2>&1 | tail -20
fi

# Checked on PID 1 rather than the image's USER directive: the entrypoint starts as root to fix
# mount ownership and then drops, so only the running process proves it actually dropped.
pid1_uid=$(docker exec "$NAME" sh -c 'awk "/^Uid:/ {print \$2}" /proc/1/status' 2>/dev/null | tr -d '[:space:]')
if [ "$pid1_uid" = "0" ] || [ -z "$pid1_uid" ]; then
  fail "app process runs as root (pid 1 uid: ${pid1_uid:-unknown})"
else
  pass "app process runs unprivileged (pid 1 uid $pid1_uid)"
fi

echo "== data durability =="

# Seed a family so there's something whose survival is observable.
admin_pw=$(docker logs "$NAME" 2>&1 | grep -A2 'Admin password' | tail -1 | tr -d '[:space:]')
jar=$(mktemp)
curl -sf -c "$jar" -X POST "localhost:$PORT/api/admin/login" \
  -H 'Content-Type: application/json' -d "{\"password\":\"$admin_pw\"}" >/dev/null 2>&1
curl -sf -b "$jar" -X POST "localhost:$PORT/api/admin/families" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Durability","password":"durability-test-pw"}' >/dev/null 2>&1

before=$(curl -sf -b "$jar" "localhost:$PORT/api/admin/families" | grep -c '"id"')

# Recreate, not restart. A restart reuses the same container and would still pass if the data
# lived in the container's writable layer instead of the volume.
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p "$PORT:3211" -v "$VOLUME:/app/data" "$IMAGE" >/dev/null
wait_healthy "$NAME" 45 >/dev/null

if curl -sf -X POST "localhost:$PORT/api/login" \
     -H 'Content-Type: application/json' -d '{"password":"durability-test-pw"}' >/dev/null 2>&1; then
  pass "data and sessions survive a container recreate (had $before families)"
else
  fail "data did not survive a container recreate"
fi

echo "== graceful shutdown =="

# node runs as PID 1, and Linux gives PID 1 no default signal dispositions — so without explicit
# handlers SIGTERM is ignored, docker waits out its grace period and SIGKILLs (exit 137, ten
# seconds, database killed mid-write). An open SSE stream also has to be closed explicitly or
# server.close() waits on it forever.
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p "$PORT:3211" -v "$VOLUME:/app/data" "$IMAGE" >/dev/null
wait_healthy "$NAME" 45 >/dev/null
jar2=$(mktemp)
curl -sf -c "$jar2" -X POST "localhost:$PORT/api/setup" -H 'Content-Type: application/json' \
  -d '{"name":"Shutdown","password":"shutdown-test-pw"}' >/dev/null 2>&1
( timeout 25 curl -sf -b "$jar2" "localhost:$PORT/api/events" >/dev/null 2>&1 & )
sleep 2
start=$(date +%s)
docker stop "$NAME" >/dev/null 2>&1
elapsed=$(( $(date +%s) - start ))
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME" 2>/dev/null)
if [ "$code" = "0" ] && [ "$elapsed" -lt 8 ]; then
  pass "shuts down gracefully on SIGTERM (${elapsed}s, exit 0)"
else
  fail "unclean shutdown: ${elapsed}s, exit ${code:-unknown} (137 = SIGKILL after grace period)"
fi

echo "== bind mount =="

# The failure this guards: Docker creates a missing host path as root, and an unprivileged app
# then can't open its own database. It killed the container outright before the entrypoint existed.
docker rm -f "$NAME" >/dev/null 2>&1
rm -rf "$BIND_DIR"
docker run -d --name "$NAME" -p "$PORT:3211" -v "$BIND_DIR:/app/data" "$IMAGE" >/dev/null
if wait_healthy "$NAME" 45; then
  pass "starts on a bind mount to a host path Docker had to create"
else
  fail "bind mount to a fresh host path breaks startup"
  docker logs "$NAME" 2>&1 | tail -15
fi

echo "== version reporting =="

# CI stamps APP_VERSION from the git tag, which carries a leading `v`. Both display sites prefix
# their own, so an unnormalized value renders as "vv0.3.0" — cosmetic, but it lands on the login
# screen of every install and is invisible in any local build, where the fallback is package.json's
# bare version.
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p "$PORT:3211" -e APP_VERSION=v9.9.9 "$IMAGE" >/dev/null
if wait_healthy "$NAME" 45; then
  reported=$(curl -sf "http://localhost:$PORT/api/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  if [ "$reported" = "9.9.9" ]; then
    pass "health reports a bare semver when the tag is v-prefixed"
  else
    fail "health reports '$reported', expected '9.9.9' (leading v not stripped)"
  fi
else
  fail "container did not start for the version check"
fi

echo
if [ "$fails" -eq 0 ]; then echo "PASS"; else echo "FAIL ($fails)"; fi
exit "$fails"
