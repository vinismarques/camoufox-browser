#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CACHE_DIR="${HOME}/.cache/camoufox-browser-skill"
PID_FILE="${CACHE_DIR}/server.pid"
LOG_FILE="${CACHE_DIR}/server.log"
PORT="${BROWSER_RUNTIME_PORT:-9487}"
HOST="${BROWSER_RUNTIME_HOST:-127.0.0.1}"

mkdir -p "${CACHE_DIR}"

if [[ ! -f "${REPO_DIR}/package.json" ]]; then
  echo "✗ Missing package.json in ${REPO_DIR}" >&2
  exit 1
fi

if [[ ! -d "${REPO_DIR}/node_modules" ]]; then
  echo "✗ node_modules missing in ${REPO_DIR}. Run: cd ${REPO_DIR} && npm install" >&2
  exit 1
fi

if [[ -f "${PID_FILE}" ]]; then
  PID="$(cat "${PID_FILE}")"
  if kill -0 "${PID}" 2>/dev/null; then
    if curl -s "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
      echo "✓ camoufox browser runtime already running (pid ${PID})"
      exit 0
    fi
  fi
fi

cd "${REPO_DIR}"
BROWSER_RUNTIME_PORT="${PORT}" BROWSER_RUNTIME_HOST="${HOST}" node src/server.js >"${LOG_FILE}" 2>&1 &
PID=$!
echo "${PID}" > "${PID_FILE}"

for _ in $(seq 1 40); do
  if curl -s "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
    echo "✓ camoufox browser runtime started (pid ${PID})"
    exit 0
  fi
  sleep 0.5
done

echo "✗ Failed to start runtime. Check ${LOG_FILE}" >&2
exit 1
