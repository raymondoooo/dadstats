#!/usr/bin/env bash
# Drives test/account-check.js through its phases: seed one instance, destroy it entirely,
# stand up a fresh one on the same host:port with the same browser profile, and assert the new
# instance never receives the old account's data.
set -uo pipefail

IMAGE="${IMAGE:-dadstats}"
PORT="${PORT:-3280}"
CPORT="${CPORT:-3211}"          # port inside the container
PROFILE=/tmp/leak-profile
HERE="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  docker rm -f acctA acctB >/dev/null 2>&1
  docker volume rm acctA-data acctB-data >/dev/null 2>&1
  rm -rf "$PROFILE"
}
trap cleanup EXIT
cleanup

wait_up() { for _ in $(seq 1 30); do curl -sf "http://localhost:$PORT/api/health" >/dev/null && return 0; sleep 1; done; return 1; }

docker run -d --name acctA -p "$PORT:$CPORT" -v acctA-data:/app/data "$IMAGE" >/dev/null
wait_up || { echo "  FAIL  instance A never started"; exit 1; }
APP_URL="http://localhost:$PORT" node "$HERE/account-check.js" seed >/dev/null || { echo "  FAIL  seeding"; exit 1; }

docker rm -f acctA >/dev/null 2>&1; docker volume rm acctA-data >/dev/null 2>&1

docker run -d --name acctB -p "$PORT:$CPORT" -v acctB-data:/app/data "$IMAGE" >/dev/null
wait_up || { echo "  FAIL  instance B never started"; exit 1; }
APP_URL="http://localhost:$PORT" node "$HERE/account-check.js" after-setup >/dev/null || { echo "  FAIL  setup on B"; exit 1; }

stored=$(docker exec acctB node -e "
const D=require('better-sqlite3');const d=new D(process.env.SQLITE_PATH,{readonly:true});
const r=d.prepare('select state from app_state').all();
const names=[];
r.forEach(x=>{const s=JSON.parse(x.state);(s.profiles||[]).forEach(p=>names.push(p.name));});
console.log(names.join(','));
")

if printf '%s' "$stored" | grep -qi "hayden"; then
  echo "  FAIL  the new instance received the previous account's data: $stored"
  exit 1
fi
echo "  ok    a rebuilt instance does not inherit the previous account's data (stored: ${stored:-none})"
echo "PASS"
