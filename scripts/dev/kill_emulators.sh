#!/usr/bin/env bash
set -euo pipefail

PORTS=(4415 4005 4505 5004 8087 9154 9199 8253 3001)

echo "[kill-emulators] stopping emulator processes (best effort)"
pkill -f "firebase emulators" >/dev/null 2>&1 || true
pkill -f firebase-tools >/dev/null 2>&1 || true
pkill -f "Serving at port" >/dev/null 2>&1 || true

declare -a ROWS=()

kill_port() {
  local p="$1"
  local lines pids
  lines="$(lsof -nP -iTCP:"${p}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2" "$1" "$9}' || true)"
  if [[ -z "${lines}" ]]; then
    ROWS+=("port=${p} status=clear")
    return
  fi
  pids="$(printf '%s\n' "${lines}" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  kill -9 ${pids} >/dev/null 2>&1 || true
  ROWS+=("port=${p} killed_pids=${pids}")
}

for p in "${PORTS[@]}"; do
  kill_port "${p}"
done

echo "[kill-emulators] result"
for r in "${ROWS[@]}"; do
  echo "  - ${r}"
done
