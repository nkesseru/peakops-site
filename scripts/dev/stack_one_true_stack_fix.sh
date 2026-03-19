#!/usr/bin/env bash
set -euo pipefail

# zsh safety if invoked from zsh
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
LOGDIR=".logs"
mkdir -p "$LOGDIR"

PROJECT_ID="${1:-peakops-pilot}"
NEXT_PORT="${2:-3000}"
ORG_ID="${3:-org_001}"
INCIDENT_ID="${4:-inc_TEST}"

echo "==> HARD KILL: free known ports"
for p in 3000 8080 5001 4000 4400 4500 9150; do
  lsof -ti tcp:$p | xargs -r kill -9 || true
done

echo "==> Ensure firebase.json pins emulator ports"
python3 - <<'PY'
import json
from pathlib import Path
p = Path("firebase.json")
cfg = json.loads(p.read_text()) if p.exists() else {}
emu = cfg.get("emulators", {})
emu["firestore"] = {"host":"127.0.0.1","port":8080}
emu["functions"]  = {"host":"127.0.0.1","port":5001}
emu["ui"]         = {"host":"127.0.0.1","port":4000}
emu["hub"]        = {"host":"127.0.0.1","port":4400}
emu["logging"]    = {"host":"127.0.0.1","port":4500}
cfg["emulators"] = emu
p.write_text(json.dumps(cfg, indent=2) + "\n")
print("✅ firebase.json updated")
PY

echo "==> Start emulators (firestore + functions) KEEPALIVE"
firebase emulators:start --only firestore,functions --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for Functions (5001) + Firestore (8080)"
for i in $(seq 1 120); do
  (echo >/dev/tcp/127.0.0.1/5001) >/dev/null 2>&1 && break || true
  sleep 0.25
done
for i in $(seq 1 120); do
  (echo >/dev/tcp/127.0.0.1/8080) >/dev/null 2>&1 && break || true
  sleep 0.25
done
echo "✅ ports open"

echo "==> Sanity: Firestore REST reachable"
curl -sS 'http://127.0.0.1:8080/v1/projects/'"$PROJECT_ID"'/databases/(default)/documents' | head -c 120; echo

echo "==> Start Next with emulator env"
export NEXT_PUBLIC_USE_EMULATORS=1
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
export FUNCTIONS_EMULATOR_HOST="127.0.0.1:5001"

rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port "$NEXT_PORT" > "../$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> Wait for Next /"
for i in $(seq 1 120); do
  if curl -sS "http://127.0.0.1:$NEXT_PORT/" >/dev/null 2>&1; then
    echo "✅ next ready"
    break
  fi
  sleep 0.25
done

echo "==> Seed incident baseline via your own API (writes to Firestore via functions)"
curl -sS "http://127.0.0.1:$NEXT_PORT/api/fn/seedIncidentBaselineV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID&requestedBy=stack_fix" | head -c 220; echo || true
curl -sS -X POST "http://127.0.0.1:$NEXT_PORT/api/fn/generateTimelineV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID&requestedBy=stack_fix" | head -c 220; echo || true
curl -sS -X POST "http://127.0.0.1:$NEXT_PORT/api/fn/generateFilingsV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID&requestedBy=stack_fix" | head -c 220; echo || true

echo "==> Verify: incident bundle + packet meta"
curl -sS "http://127.0.0.1:$NEXT_PORT/api/fn/getIncidentBundleV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 220; echo
curl -sS "http://127.0.0.1:$NEXT_PORT/api/fn/getIncidentPacketMetaV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 220; echo

echo
echo "✅ STACK UP (DO NOT CLOSE THIS TERMINAL)"
echo "OPEN:  http://127.0.0.1:$NEXT_PORT/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "BUNDLE: http://127.0.0.1:$NEXT_PORT/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
echo "LOGS:  tail -n 200 $LOGDIR/emulators.log"
echo "       tail -n 200 $LOGDIR/next.log"
echo "STOP:  kill $EMU_PID $NEXT_PID"
echo
wait
