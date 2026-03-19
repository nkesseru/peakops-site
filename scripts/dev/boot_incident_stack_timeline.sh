#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

mkdir -p .logs

echo "==> kill ports"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

echo "==> start emulators"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null || { echo "❌ hello not up"; tail -n 80 .logs/emulators.log; exit 1; }
echo "✅ emulators ready (pid=$EMU_PID)"

echo "==> start next"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
sleep 2
curl -fsSI http://127.0.0.1:3000 | head -n 5 >/dev/null || { echo "❌ next not up"; tail -n 80 .logs/next.log; exit 1; }
echo "✅ next ready (pid=$NEXT_PID)"

echo
echo "==> generate timeline"
curl -sS -X POST "$FN_BASE/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
| python3 -m json.tool | head -n 60

echo
echo "==> read timeline (count should be > 0)"
curl -sS "http://127.0.0.1:3000/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" \
| python3 -m json.tool | head -n 120

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
