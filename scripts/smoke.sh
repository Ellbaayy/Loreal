#!/usr/bin/env bash
# Smoke + security checks against a running instance.
#
#   ./scripts/smoke.sh [base_url]
#
# Every check is an invariant the app must keep: no source or secret files
# served, errors are client errors not 500s, admin auth only accepts its own
# signed token, and uploads are rejected when the bytes are not an image.
set -uo pipefail

BASE=${1:-http://127.0.0.1:7860}
PASS=0
FAIL=0

chk() {
  local name=$1 want=$2 got=$3
  if [ "$want" = "$got" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %-34s %s\n' "$name" "$got"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %-34s want %s got %s\n' "$name" "$want" "$got"
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

chk "static /" 200 "$(code "$BASE/")"
chk "static /admin/" 200 "$(code "$BASE/admin/")"
chk "no .env" 404 "$(code "$BASE/.env")"
chk "no .git/config" 404 "$(code "$BASE/.git/config")"
chk "no source file" 404 "$(code "$BASE/src/db.ts")"
chk "no schema.sql" 404 "$(code "$BASE/schema.sql")"
chk "no seed.sql" 404 "$(code "$BASE/seed.sql")"
chk "no package.json" 404 "$(code "$BASE/package.json")"
chk "unknown api route" 404 "$(code "$BASE/api/nope")"
chk "bad JSON body" 400 "$(code -X POST "$BASE/api/chat" -H 'Content-Type: application/json' -d '{bad')"
chk "non-numeric session id" 404 "$(code "$BASE/api/sessions/abc/messages")"
chk "admin without token" 401 "$(code "$BASE/api/admin/perfumes")"
chk "admin with password as token" 401 "$(code -H 'Authorization: Bearer group3jaya' "$BASE/api/admin/perfumes")"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
printf 'not an image' > "$TMP"
chk "non-image upload" 415 "$(code -X POST "$BASE/api/chat/with-image" -F "image=@$TMP")"

TOKEN=$(curl -s -X POST "$BASE/api/admin/login" -H 'Content-Type: application/json' \
  -d "{\"password\":\"${ADMIN_PASSWORD:-group3jaya}\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$TOKEN" ]; then
  chk "admin with signed token" 200 "$(code -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/perfumes")"
else
  FAIL=$((FAIL + 1))
  echo "FAIL  admin login returned no token"
fi

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
