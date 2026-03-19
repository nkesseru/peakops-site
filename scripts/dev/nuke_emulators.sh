#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_lib_repo.sh"
require_bash
REPO_ROOT="$(repo_root "${SCRIPT_DIR}")"
cd "${REPO_ROOT}"

PORTS=(3000 3001 4005 4415 4505 5004 8087 9154 9199)

say(){ echo "[nuke-emulators] $*"; }
fail(){ echo "[nuke-emulators] FAIL: $*" >&2; exit 1; }

say "killing firebase/emulator processes (best effort)"
pkill -f "firebase emulators:start" >/dev/null 2>&1 || true
pkill -f "firebase emulators" >/dev/null 2>&1 || true
pkill -f "firebase-tools" >/dev/null 2>&1 || true
pkill -f "emulators:start" >/dev/null 2>&1 || true

if command -v jps >/dev/null 2>&1; then
  jps -l 2>/dev/null | awk '/CloudFirestore|firestore/{print $1}' | while read -r pid; do
    [[ -n "${pid}" ]] || continue
    say "killing java firestore pid=${pid}"
    kill -9 "${pid}" >/dev/null 2>&1 || true
  done
fi

say "killing listeners on ports: ${PORTS[*]}"
for p in "${PORTS[@]}"; do
  rows="$(lsof -nP -iTCP:${p} -sTCP:LISTEN 2>/dev/null || true)"
  pids="$(printf '%s\n' "${rows}" | awk 'NR>1{print $2}' | sort -u)"
  if [[ -n "${pids}" ]]; then
    say "port ${p}"
    printf '%s\n' "${rows}" | sed -n '1,6p'
    kill -9 ${pids} >/dev/null 2>&1 || true
  fi
done

sleep 1
still_busy=0
for p in "${PORTS[@]}"; do
  if lsof -nP -iTCP:${p} -sTCP:LISTEN >/dev/null 2>&1; then
    still_busy=1
    say "port ${p} still busy after kill attempts:"
    lsof -nP -iTCP:${p} -sTCP:LISTEN || true
  fi
done
[[ "${still_busy}" == "0" ]] || fail "one or more required ports remain busy"

say "done"
