#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${BROWSER_RUNTIME_HOST:-127.0.0.1}"
PORT="${BROWSER_RUNTIME_PORT:-9487}"
BASE_URL="http://${HOST}:${PORT}"
LOG_DIR="${HOME}/.cache/camoufox-browser"
LOG_FILE="${LOG_DIR}/smoke-server.log"

mkdir -p "$LOG_DIR"

STARTED_HERE=0
SERVER_PID=""
SESSION_ID=""

cleanup() {
  if [ -n "$SESSION_ID" ]; then
    curl -s -X DELETE "$BASE_URL/sessions/$SESSION_ID" >/dev/null 2>&1 || true
  fi

  if [ "$STARTED_HERE" -eq 1 ] && [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_for_health() {
  for _ in $(seq 1 40); do
    if curl -s "$BASE_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

if ! curl -s "$BASE_URL/health" >/dev/null 2>&1; then
  STARTED_HERE=1

  pushd "$ROOT_DIR" >/dev/null
  CAMOUFOX_HEADLESS="${CAMOUFOX_HEADLESS:-true}" \
  BROWSER_RUNTIME_HOST="$HOST" \
  BROWSER_RUNTIME_PORT="$PORT" \
    node src/server.js > "$LOG_FILE" 2>&1 &
  SERVER_PID=$!
  popd >/dev/null

  if ! wait_for_health; then
    echo "✗ smoke: runtime failed to start (see $LOG_FILE)"
    exit 1
  fi
fi

HEALTH_JSON="$(curl -s "$BASE_URL/health")"
HEALTH_OK="$(python3 - <<'PY' "$HEALTH_JSON"
import json,sys
try:
    data=json.loads(sys.argv[1])
    print('1' if data.get('ok') else '0')
except Exception:
    print('0')
PY
)"

if [ "$HEALTH_OK" != "1" ]; then
  echo "✗ smoke: /health did not return ok=true"
  exit 1
fi

SESSION_JSON="$(curl -s -X POST "$BASE_URL/sessions" \
  -H 'Content-Type: application/json' \
  -d '{"persistent":false}')"

SESSION_ID="$(python3 - <<'PY' "$SESSION_JSON"
import json,sys
print(json.loads(sys.argv[1]).get('id',''))
PY
)"

if [ -z "$SESSION_ID" ]; then
  echo "✗ smoke: failed to create session"
  exit 1
fi

TAB_JSON="$(curl -s -X POST "$BASE_URL/sessions/$SESSION_ID/tabs" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}')"

TAB_ID="$(python3 - <<'PY' "$TAB_JSON"
import json,sys
print(json.loads(sys.argv[1]).get('id',''))
PY
)"

if [ -z "$TAB_ID" ]; then
  echo "✗ smoke: failed to create tab"
  exit 1
fi

INSPECT_JSON="$(curl -s -X POST "$BASE_URL/tabs/$TAB_ID/inspect" \
  -H 'Content-Type: application/json' \
  -d '{"limit":50}')"

INSPECT_OK="$(python3 - <<'PY' "$INSPECT_JSON"
import json,sys
try:
    data=json.loads(sys.argv[1])
    targets=data.get('targets',[])
    print('1' if isinstance(targets,list) else '0')
except Exception:
    print('0')
PY
)"

if [ "$INSPECT_OK" != "1" ]; then
  echo "✗ smoke: inspect check failed"
  exit 1
fi

ACT_JSON="$(curl -s -X POST "$BASE_URL/tabs/$TAB_ID/act" \
  -H 'Content-Type: application/json' \
  -d '{"action":"wait","input":{"condition":{"kind":"textPresent","value":"Example Domain"}},"options":{"timeoutMs":10000}}')"

ACT_OK="$(python3 - <<'PY' "$ACT_JSON"
import json,sys
try:
    data=json.loads(sys.argv[1])
    print('1' if data.get('ok') else '0')
except Exception:
    print('0')
PY
)"

if [ "$ACT_OK" != "1" ]; then
  echo "✗ smoke: act(wait) check failed"
  exit 1
fi

EVENTS_JSON="$(curl -s "$BASE_URL/tabs/$TAB_ID/events?since=0&limit=200")"
EVENTS_OK="$(python3 - <<'PY' "$EVENTS_JSON"
import json,sys
try:
    data=json.loads(sys.argv[1])
    kinds=[e.get('kind') for e in data.get('events',[])]
    print('1' if 'request' in kinds and 'response' in kinds else '0')
except Exception:
    print('0')
PY
)"

if [ "$EVENTS_OK" != "1" ]; then
  echo "✗ smoke: events check failed"
  exit 1
fi

echo "✓ smoke: runtime healthy, session/tab/inspect/act/events checks passed"
