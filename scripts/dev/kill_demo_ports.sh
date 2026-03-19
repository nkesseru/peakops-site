#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PORTS=(3000 3001 4005 4415 4505 5001 5002 5003 5004 8086 8087 9154 9199 8099 8223 8232 8253 8266 8339 8371 8458 8624 8664)

say(){ echo "[demo-kill] $*"; }

say "Killing listeners on ports: ${PORTS[*]}"
for p in "${PORTS[@]}"; do
  pids="$(lsof -nP -iTCP:"${p}" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    say "port ${p} -> PID(s): ${pids}"
    kill -9 ${pids} >/dev/null 2>&1 || true
  fi
done

say "Killing firebase emulator processes (best effort)"
pkill -f firebase-tools >/dev/null 2>&1 || true
pkill -f "firebase emulators" >/dev/null 2>&1 || true
pkill -f "emulators:start" >/dev/null 2>&1 || true

if command -v jps >/dev/null 2>&1; then
  say "Killing Java Firestore emulator processes (best effort)"
  jps -l 2>/dev/null | awk '/CloudFirestore|firestore/{print $1}' | while read -r pid; do
    [[ -n "${pid}" ]] || continue
    say "java pid ${pid}"
    kill -9 "${pid}" >/dev/null 2>&1 || true
  done
fi

say "Done."
