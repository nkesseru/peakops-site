#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

# Usage:
#   bash scripts/dev/mega_boot_seed_incident_timeline_and_fix_autochecks.sh peakops-pilot org_001 inc_TEST car_abc123 http://127.0.0.1:3000
PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
CONTRACT_ID="${4:-car_abc123}"
BASE_URL="${5:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
[[ -d "$ROOT/next-app" ]] || { echo "❌ Run from repo root (contains next-app/)"; exit 1; }

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> kill ports + stray processes"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

echo "==> start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> wait for hello"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null || { echo "❌ emulator hello not responding"; tail -n 160 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ emulators ready (pid=$EMU_PID)"

echo "==> ensure Next points to emulator (FN_BASE)"
# Prefer putting FN_BASE into next-app/.env.local so proxy works reliably.
ENV_LOCAL="$ROOT/next-app/.env.local"
touch "$ENV_LOCAL"
if rg -n "^FN_BASE=" "$ENV_LOCAL" >/dev/null 2>&1; then
  perl -0777 -pe 's/^FN_BASE=.*$/FN_BASE=http:\/\/127.0.0.1:5001\/'"$PROJECT_ID"'\/us-central1/m' -i "$ENV_LOCAL"
else
  printf "\nFN_BASE=http://127.0.0.1:5001/%s/us-central1\n" "$PROJECT_ID" >> "$ENV_LOCAL"
fi

echo "==> start Next"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2
curl -fsSI "$BASE_URL" | head -n 5 >/dev/null || { echo "❌ next not responding"; tail -n 160 "$LOGDIR/next.log"; exit 1; }
echo "✅ next ready (pid=$NEXT_PID)"

echo "==> seed incident baseline doc in Firestore emulator (so auto-checks stop yelling)"
# NOTE: This uses the Firestore REST emulator and works without firebase-admin in this script.
FIRESTORE_EMU_HOST="127.0.0.1:8081"
DOC_PATH="projects/${PROJECT_ID}/databases/(default)/documents/incidents/${INCIDENT_ID}"
NOW="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
curl -sS -X PATCH \
  "http://${FIRESTORE_EMU_HOST}/v1/${DOC_PATH}?updateMask.fieldPaths=orgId&updateMask.fieldPaths=title&updateMask.fieldPaths=startTime&updateMask.fieldPaths=updatedAt&updateMask.fieldPaths=createdAt" \
  -H "Content-Type: application/json" \
  -d "{
    \"fields\": {
      \"orgId\": {\"stringValue\": \"${ORG_ID}\"},
      \"title\": {\"stringValue\": \"Seed Incident ${INCIDENT_ID}\"},
      \"startTime\": {\"stringValue\": \"${NOW}\"},
      \"createdAt\": {\"timestampValue\": \"${NOW}\"},
      \"updatedAt\": {\"timestampValue\": \"${NOW}\"}
    }
  }" >/dev/null
echo "✅ incident seeded: incidents/${INCIDENT_ID} (title/startTime/orgId)"

echo "==> seed timeline via Next proxy (POST generateTimelineV1)"
curl -sS -X POST "$BASE_URL/api/fn/generateTimelineV1" \
  -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"admin_ui\"}" \
  | (command -v python3 >/dev/null && python3 -m json.tool | head -n 80 || cat)

echo
echo "==> verify timeline reads (GET getTimelineEvents, expect count>0)"
curl -sS "$BASE_URL/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" \
  | (command -v python3 >/dev/null && python3 -m json.tool | head -n 200 || cat)

echo
echo "==> generate filings via Next proxy (already wired) "
curl -sS "$BASE_URL/api/fn/generateFilingsV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" \
  | (command -v python3 >/dev/null && python3 -m json.tool | head -n 120 || cat)

echo
echo "==> verify packet HEAD works (downloadIncidentPacketZip)"
curl -fsSI "$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID&contractId=$CONTRACT_ID" | head -n 20 || true

echo
echo "✅ STACK UP (KEEPING RUNNING)"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 200 $LOGDIR/emulators.log"
echo "  tail -n 200 $LOGDIR/next.log"
echo
echo "STOP (when ready):"
echo "  kill $EMU_PID $NEXT_PID"
