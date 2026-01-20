#!/usr/bin/env bash
set -euo pipefail

# zsh safety if you run via zsh
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

LOGDIR=".logs"
mkdir -p "$LOGDIR"

echo "==> HARD KILL common ports (avoid ghost emulators)"
for p in "$NEXT_PORT" 5001 8080 4000 4400 4500 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done

echo "==> Ensure firebase.json pins ports + points functions to functions_clean"
cat > firebase.json <<JSON
{
  "functions": [
    { "source": "functions_clean" }
  ],
  "emulators": {
    "functions": { "host": "127.0.0.1", "port": 5001 },
    "firestore": { "host": "127.0.0.1", "port": 8080 },
    "hub":       { "host": "127.0.0.1", "port": 4400 },
    "ui":        { "host": "127.0.0.1", "port": 4000 },
    "logging":   { "host": "127.0.0.1", "port": 4500 }
  }
}
JSON

echo "==> Patch functions_clean/package.json engines.node to EXACT 22 (not >=22)"
node - <<'NODE'
const fs = require("fs");
const p = "functions_clean/package.json";
if (!fs.existsSync(p)) {
  console.error("❌ missing " + p);
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.engines = j.engines || {};
// Firebase emulator is picky; keep it exact.
j.engines.node = "22";
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("✅ set functions_clean/package.json engines.node=22");
NODE

echo "==> Start emulators (firestore + functions) KEEPALIVE"
firebase emulators:start --only firestore,functions --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for Functions (5001) + Firestore (8080)"
for i in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:5001" >/dev/null 2>&1 && break || true
  sleep 0.25
done
for i in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:8080/" >/dev/null 2>&1 && break || true
  sleep 0.25
done

echo "==> Sanity: list functions (should NOT say 'Failed to initialize')"
if rg -n "Failed to initialize|No valid functions configuration" "$LOGDIR/emulators.log" >/dev/null 2>&1; then
  echo "❌ Functions emulator did not initialize. See $LOGDIR/emulators.log"
  tail -n 80 "$LOGDIR/emulators.log" || true
  exit 1
fi

echo "==> Seed incident doc via Firestore REST (quoted URL w/(default))"
DOC_URL="http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}"
curl -fsS -X PATCH "$DOC_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": { \"stringValue\": \"${ORG_ID}\" },
      \"title\": { \"stringValue\": \"Seed Incident ${INCIDENT_ID}\" },
      \"startTime\": { \"stringValue\": \"2026-01-16T00:00:00.000Z\" }
    }
  }" >/dev/null

echo "✅ seeded incidents/${INCIDENT_ID}"

echo "==> Start Next (port ${NEXT_PORT})"
pkill -f "pnpm dev --port ${NEXT_PORT}" 2>/dev/null || true
( cd next-app && pnpm dev --port "${NEXT_PORT}" > "../${LOGDIR}/next.log" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> Wait for Next (/)"
for i in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1 && break || true
  sleep 0.25
done
echo "✅ next ready"

BASE="http://127.0.0.1:${NEXT_PORT}"

echo "==> Run generators via Next API"
curl -fsS -X POST "${BASE}/api/fn/generateTimelineV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=seed_fix" | head -c 180; echo
curl -fsS -X POST "${BASE}/api/fn/generateFilingsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=seed_fix" | head -c 180; echo

echo "==> Verify endpoints (MUST be JSON, not 'Function does not exist')"
curl -fsS "${BASE}/api/fn/getIncidentBundleV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 200; echo
curl -fsS "${BASE}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 200; echo

echo
echo "✅ STACK UP (DO NOT CLOSE THIS TERMINAL)"
echo "OPEN:   ${BASE}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo "LOGS:   tail -n 200 ${LOGDIR}/emulators.log"
echo "        tail -n 200 ${LOGDIR}/next.log"
echo "STOP:   kill ${EMU_PID} ${NEXT_PID}"
wait
