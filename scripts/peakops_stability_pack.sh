#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/kesserumini/peakops/my-app"
NEXT_DIR="$ROOT/next-app"
PROJ="peakops-pilot"

NX="http://127.0.0.1:3001"
FN="http://127.0.0.1:5004/${PROJ}/us-central1"
FS="http://127.0.0.1:8087"
ST="http://127.0.0.1:9199"

ORG="riverbend-electric"
INC="inc_demo"
ACTOR="dev-admin"
DEMO_PIC="/Users/kesserumini/Downloads/PeakOps Demo Pics-3/8.png"

EMU_LOG="/tmp/peakops_emulators.log"
NEXT_LOG="/tmp/peakops_next.log"

need() { command -v "$1" >/dev/null 2>&1 || { echo "❌ Missing: $1"; exit 1; }; }
need lsof
need kill
need curl
need jq
need python3
need firebase
need npm

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [[ -n "${pids:-}" ]]; then
    echo "🔪 Killing port $port PIDs: $pids"
    for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
  else
    echo "✅ Port $port free"
  fi
}

wait_for() {
  local name="$1"; local cmd="$2"; local tries="${3:-140}"
  local i=0
  while (( i < tries )); do
    if eval "$cmd" >/dev/null 2>&1; then
      echo "✅ $name ready"
      return 0
    fi
    sleep 1
    ((i++))
  done
  echo "❌ Timeout waiting for $name"
  echo "--- Next log tail ---"; tail -n 80 "$NEXT_LOG" || true
  echo "--- Emulator log tail ---"; tail -n 160 "$EMU_LOG" || true
  return 1
}

echo "== PeakOps Stability Pack =="
echo "ORG=$ORG INC=$INC"
echo "NX=$NX"
echo "FN=$FN"
echo

echo "== Cold stop =="
kill_port 3001
kill_port 5004
kill_port 8087
kill_port 9199

: > "$EMU_LOG"
: > "$NEXT_LOG"

echo
echo "== Start emulators =="
cd "$ROOT"
( firebase emulators:start --project "$PROJ" >>"$EMU_LOG" 2>&1 ) &
EMU_PID=$!
echo "✅ Emulators PID=$EMU_PID (log: $EMU_LOG)"

echo
echo "== Start Next =="
cd "$NEXT_DIR"
( npm run dev -- --hostname 127.0.0.1 --port 3001 >>"$NEXT_LOG" 2>&1 ) &
NEXT_PID=$!
echo "✅ Next PID=$NEXT_PID (log: $NEXT_LOG)"

echo
echo "== Wait for core services =="
wait_for "Next" "curl -sS $NX >/dev/null"
wait_for "Storage" "curl -sS $ST/ >/dev/null"
wait_for "Firestore" "curl -sS $FS/ >/dev/null"
wait_for "Functions healthzV1" "curl -sS $FN/healthzV1 | jq -e '.ok==true' >/dev/null" 160

echo
echo "== Verify core API endpoints =="
curl -sS "$NX/api/fn/getIncidentV1?orgId=$ORG&incidentId=$INC" | jq -e '.ok!=null' >/dev/null
curl -sS "$NX/api/fn/listJobsV1?orgId=$ORG&incidentId=$INC&limit=5" | jq -e '.ok!=null' >/dev/null
echo "✅ /api/fn proxy is working"

echo
echo "== Ensure evidence exists (auto-upload demo if none) =="
EV_URL="$NX/api/fn/listEvidenceLocker?orgId=$ORG&incidentId=$INC&limit=25"
EV_JSON="$(curl -sS "$EV_URL")"
echo "$EV_JSON" | jq -e '.ok==true' >/dev/null

EV_COUNT="$(echo "$EV_JSON" | jq -r '.count // ((.docs|length)//(.items|length)//0)')"

if [[ "$EV_COUNT" == "0" ]]; then
  echo "⚠️ No evidence found. Uploading demo pic: $DEMO_PIC"
  if [[ ! -f "$DEMO_PIC" ]]; then
    echo "❌ Demo pic missing: $DEMO_PIC"
    exit 1
  fi
  UP_OUT="$(bash /tmp/peakops_upload_real_demo_pic.sh "$DEMO_PIC")"
echo "$UP_OUT" | jq -e '.ok==true' >/dev/null

# Prefer uploader output (most reliable, avoids listEvidenceLocker races)
EVID="$(echo "$UP_OUT" | jq -r '.evidenceId // ""')"
BUCKET="$(echo "$UP_OUT" | jq -r '.bucket // ""')"
SPATH="$(echo "$UP_OUT" | jq -r '.storagePath // ""')"

if [[ -z "${EVID:-}" || -z "${BUCKET:-}" || -z "${SPATH:-}" ]]; then
  echo "⚠️ Uploader returned missing fields. Falling back to listEvidenceLocker retry..."
fi


  # Wait for evidence to appear (avoid race with emulator writes)
  for i in $(seq 1 12); do
    EV_JSON="$(curl -sS "$EV_URL")"
    EV_COUNT="$(echo "$EV_JSON" | jq -r '.count // ((.docs|length)//(.items|length)//0)')"
    if [[ "$EV_COUNT" != "0" ]]; then
      break
    fi
    sleep 0.75
  done



  # Wait for evidence to appear (avoid race with emulator writes)
  for i in $(seq 1 12); do
    EV_JSON="$(curl -sS "$EV_URL")"
    EV_COUNT="$(echo "$EV_JSON" | jq -r '.count // ((.docs|length)//(.items|length)//0)')"
    if [[ "$EV_COUNT" != "0" ]]; then
      break
    fi
    sleep 0.75
  done


  EV_JSON="$(curl -sS "$EV_URL")"
  echo "$EV_JSON" | jq -e '.ok==true' >/dev/null
fi

# Extract latest evidence fields (robust across shapes)
EVID="$(echo "$EV_JSON" | jq -r '(.docs[0].id // .items[0].id // .docs[0].evidenceId // .items[0].evidenceId // "")')"
BUCKET="$(echo "$EV_JSON" | jq -r '(.docs[0].file.bucket // .items[0].file.bucket // .docs[0].bucket // .items[0].bucket // "")')"
SPATH="$(echo "$EV_JSON" | jq -r '(.docs[0].file.storagePath // .items[0].file.storagePath // .docs[0].storagePath // .items[0].storagePath // "")')"

# Debug dump if missing
if [[ -z "${EVID:-}" || -z "${BUCKET:-}" || -z "${SPATH:-}" ]]; then
  echo "❌ Could not infer evidence fields from listEvidenceLocker response."
  echo "evidenceId=$EVID"
  echo "bucket=$BUCKET"
  echo "storagePath=$SPATH"
  echo "First doc:"
  echo "$EV_JSON" | jq '.docs[0] // .items[0]'
  exit 1
fi

echo "✅ Evidence selected:"

echo "  evidenceId=$EVID"
echo "  bucket=$BUCKET"
echo "  storagePath=$SPATH"

echo
echo "== Verify /api/media renders bytes =="
MEDIA_URL="$NX/api/media?bucket=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$BUCKET'''))")&path=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$SPATH'''))")"
curl -sS -I "$MEDIA_URL" | head -n 14
CODE="$(curl -sS -o /dev/null -w "%{http_code}" -I "$MEDIA_URL")"
if [[ "$CODE" != "200" && "$CODE" != "206" ]]; then
  echo "❌ /api/media not serving: HTTP $CODE"
  exit 1
fi
echo "✅ /api/media OK"

echo
echo "== Create job → assign evidence → mark complete =="
JOB_JSON="$(curl -sS -X POST "$NX/api/fn/createJobV1" \
  -H "content-type: application/json" \
  --data "{\"orgId\":\"$ORG\",\"incidentId\":\"$INC\",\"title\":\"StabilityPack Job $(date +%H:%M:%S)\",\"actorUid\":\"$ACTOR\"}")"
echo "$JOB_JSON" | jq
JOB_ID="$(echo "$JOB_JSON" | jq -r '.jobId // .id // ""')"
[[ -n "$JOB_ID" ]] || { echo "❌ createJobV1 returned no jobId"; exit 1; }
echo "jobId=$JOB_ID"

ASSIGN_JSON="$(curl -sS -X POST "$NX/api/fn/assignEvidenceToJobV1" \
  -H "content-type: application/json" \
  --data "{\"orgId\":\"$ORG\",\"incidentId\":\"$INC\",\"evidenceId\":\"$EVID\",\"jobId\":\"$JOB_ID\"}")"
echo "$ASSIGN_JSON" | jq
[[ "$(echo "$ASSIGN_JSON" | jq -r '.ok // false')" == "true" ]] || { echo "❌ assignEvidenceToJobV1 failed"; exit 1; }

DONE_JSON="$(curl -sS -X POST "$NX/api/fn/updateJobStatusV1" \
  -H "content-type: application/json" \
  --data "{\"orgId\":\"$ORG\",\"incidentId\":\"$INC\",\"jobId\":\"$JOB_ID\",\"status\":\"complete\"}")"
echo "$DONE_JSON" | jq
[[ "$(echo "$DONE_JSON" | jq -r '.ok // false')" == "true" ]] || { echo "❌ updateJobStatusV1 failed"; exit 1; }

echo
echo "✅ STABILITY PACK PASSED."
echo
echo "Open:"
echo "  $NX/incidents/$INC"
echo "  $NX/incidents/$INC/review"
echo
echo "Logs:"
echo "  tail -f $NEXT_LOG"
echo "  tail -f $EMU_LOG"
echo
echo "Stop all:"
echo "  kill -9 $NEXT_PID $EMU_PID"
