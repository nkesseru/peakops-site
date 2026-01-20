#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
NEXT_PORT="${2:-3000}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

LOGDIR=".logs"
mkdir -p "$LOGDIR"

echo "==> HARD RESET: kill anything on known emulator ports"
# Firebase emulators commonly use these ports:
# - hub: 4400
# - ui: 4000
# - logging: 4500
# - firestore: 8080 (or 8081 depending on config)
# - functions: 5001
# - hosting (rare): 5000
PORTS=(3000 4000 4400 4500 4501 5000 5001 8080 8081)

for p in "${PORTS[@]}"; do
  if lsof -ti tcp:"$p" >/dev/null 2>&1; then
    echo "  killing port $p -> $(lsof -ti tcp:"$p" | tr '\n' ' ')"
    lsof -ti tcp:"$p" | xargs kill -9 >/dev/null 2>&1 || true
  fi
done

echo "==> Ensure firebase.json pins ports (firestore=8080, functions=5001, hub=4400, ui=4000, logging=4500)"
# Patch firebase.json to deterministic ports. (Safe if already present.)
python3 - <<'PY'
from pathlib import Path
import json

p = Path("firebase.json")
if not p.exists():
    raise SystemExit("❌ firebase.json not found at repo root")

j = json.loads(p.read_text())
emu = j.setdefault("emulators", {})

emu.setdefault("ui", {})["port"] = 4000
emu.setdefault("hub", {})["port"] = 4400
emu.setdefault("logging", {})["port"] = 4500
emu.setdefault("firestore", {})["port"] = 8080
emu.setdefault("functions", {})["port"] = 5001

p.write_text(json.dumps(j, indent=2) + "\n")
print("✅ firebase.json updated")
PY

echo "==> Start emulators (firestore + functions) KEEPALIVE"
firebase emulators:start --only firestore,functions --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for Functions emulator (:5001)"
for i in $(seq 1 120); do
  if nc -z 127.0.0.1 5001 >/dev/null 2>&1; then
    echo "✅ functions port open"
    break
  fi
  sleep 0.25
done

echo "==> Wait for Firestore emulator (:8080)"
for i in $(seq 1 120); do
  if nc -z 127.0.0.1 8080 >/dev/null 2>&1; then
    echo "✅ firestore port open"
    break
  fi
  sleep 0.25
done

echo "==> Sanity check: can CONNECT to Firestore emulator"
curl -sS "http://127.0.0.1:8080/" >/dev/null 2>&1 || true

echo "==> Restart Next (clean cache) with emulator env"
pkill -f "pnpm dev --port $NEXT_PORT" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true

(
  cd next-app
  # Firestore Admin SDK uses FIRESTORE_EMULATOR_HOST (host:port), NOT a URL.
  export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
  export GCLOUD_PROJECT="$PROJECT_ID"
  export NEXT_PUBLIC_PROJECT_ID="$PROJECT_ID"

  # Your Next routes/proxy code uses FN_BASE / NEXT_PUBLIC_FN_BASE in a bunch of places.
  export FN_BASE="http://127.0.0.1:5001/$PROJECT_ID/us-central1"
  export NEXT_PUBLIC_FN_BASE="$FN_BASE"

  pnpm dev --port "$NEXT_PORT" > "../$LOGDIR/next.log" 2>&1
) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> Wait for Next (/)"
for i in $(seq 1 120); do
  if curl -sS "http://127.0.0.1:$NEXT_PORT/" >/dev/null 2>&1; then
    echo "✅ next ready"
    break
  fi
  sleep 0.25
done

echo
echo "✅ STACK UP"
echo "OPEN:  http://127.0.0.1:$NEXT_PORT/admin/incidents/inc_TEST?orgId=org_001"
echo "BUNDLE: http://127.0.0.1:$NEXT_PORT/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "LOGS:  tail -n 200 $LOGDIR/emulators.log"
echo "       tail -n 200 $LOGDIR/next.log"
echo "STOP:  kill $EMU_PID $NEXT_PID"
echo

wait
