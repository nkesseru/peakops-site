#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

PORTS=(4415 4005 4505 5004 8086 8087 9154 9199 8253 8099 3001 3000)

say(){ echo "[kill-harder] $*"; }

say "Killing listeners on ports: ${PORTS[*]}"
for p in "${PORTS[@]}"; do
  pids="$(lsof -nP -iTCP:${p} -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    say "port ${p} -> PID(s): ${pids}"
    kill -9 ${pids} >/dev/null 2>&1 || true
  fi
done

say "pkill firebase-tools/emulators (best effort)"
pkill -f "firebase emulators" >/dev/null 2>&1 || true
pkill -f firebase-tools >/dev/null 2>&1 || true
pkill -f "emulators:start" >/dev/null 2>&1 || true
pkill -f "Serving at port" >/dev/null 2>&1 || true

# Firestore emulator is Java; sometimes it survives.
if command -v jps >/dev/null 2>&1; then
  say "Java processes (jps -l):"
  jps -l || true
fi

say "Done."
