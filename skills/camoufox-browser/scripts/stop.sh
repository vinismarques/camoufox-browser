#!/usr/bin/env bash
set -euo pipefail

CACHE_DIR="${HOME}/.cache/camoufox-browser-skill"
PID_FILE="${CACHE_DIR}/server.pid"

if [[ -f "${PID_FILE}" ]]; then
  PID="$(cat "${PID_FILE}")"
  if kill -0 "${PID}" 2>/dev/null; then
    kill "${PID}" >/dev/null 2>&1 || true

    for _ in $(seq 1 40); do
      if ! kill -0 "${PID}" 2>/dev/null; then
        rm -f "${PID_FILE}"
        echo "✓ camoufox browser runtime stopped"
        exit 0
      fi
      sleep 0.25
    done

    kill -9 "${PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${PID_FILE}"
fi

echo "✓ camoufox browser runtime was not running"
