#!/usr/bin/env bash
set -euo pipefail

say(){ echo "[kill-drift] $*"; }

PORTS=(3001 3000 4415 4005 4505 5004 8086 8087 9154 9199 8223 8232 8253 8266 8099 8371 8458 8624 8664)

say "Killing listeners on ports: ${PORTS[*]}"
for p in "${PORTS[@]}"; do
  pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    say "port $p -> PIDs: $pids"
    kill -9 $pids >/dev/null 2>&1 || true
  fi
done

say "Killing firebase emulator processes (best-effort)"
pkill -f "firebase-tools" >/dev/null 2>&1 || true
pkill -f "firebase emulators" >/dev/null 2>&1 || true
pkill -f "emulators:start" >/dev/null 2>&1 || true

# Firestore emulator can leave a JVM behind.
if command -v jps >/dev/null 2>&1; then
  say "Killing Firestore emulator JVMs (best-effort)"
  while read -r pid cmd; do
    if echo "$cmd" | grep -qi "cloud-firestore-emulator"; then
      say "killing java PID $pid ($cmd)"
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  done < <(ps -axo pid,command | grep -i "cloud-firestore-emulator" | grep -v grep || true)
fi

say "Done."
