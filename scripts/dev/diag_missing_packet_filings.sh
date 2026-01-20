#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
PROJECT_ID="${3:-peakops-pilot}"
CONTRACT_ID="${4:-car_abc123}"

# --- locate repo root (must contain next-app/) ---
ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app" ]]; do ROOT="$(dirname "$ROOT")"; done
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Could not find repo root containing next-app/"
  exit 1
fi
cd "$ROOT"

LOGDIR=".logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d_%H%M%S)"

echo "==> ROOT=$ROOT"
echo "==> ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID PROJECT_ID=$PROJECT_ID CONTRACT_ID=$CONTRACT_ID"
echo

# --- hard kill common ports + stray procs ---
echo "==> kill old ports (3000,5001,8081,4400,4409,9150)"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

# --- start emulators ---
echo "==> start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> wait for hello"
for i in $(seq 1 140); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ emulator hello not responding"; tail -n 140 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ emulators ready (pid=$EMU_PID)"
echo

# --- start Next ---
echo "==> start Next"
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2
BASE_URL="http://127.0.0.1:3000"

INC_URL="$BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "==> smoke incident page"
curl -fsS "$INC_URL" >/dev/null || { echo "❌ incident page failing"; tail -n 160 "$LOGDIR/next.log"; exit 1; }
echo "✅ incident page ok"
echo

# --- check bundle endpoint(s) ---
# you have getIncidentBundleV1 route in Next; there may also be getIncidentBundle alias
BUNDLE_URL_1="$BASE_URL/api/fn/getIncidentBundleV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
BUNDLE_URL_2="$BASE_URL/api/fn/getIncidentBundle?orgId=$ORG_ID&incidentId=$INCIDENT_ID"

echo "==> check bundle endpoints"
echo "   1) $BUNDLE_URL_1"
B1="$(curl -fsS "$BUNDLE_URL_1" || true)"
echo "$B1" | head -c 260; echo
echo "   2) $BUNDLE_URL_2"
B2="$(curl -fsS "$BUNDLE_URL_2" || true)"
echo "$B2" | head -c 260; echo
echo

echo "==> does bundle JSON include filings[]?"
python3 - <<PY
import json,sys
def chk(label, raw):
    raw = raw.strip()
    if not raw:
        print(f"{label}: ❌ empty")
        return
    try:
        j=json.loads(raw)
    except Exception as e:
        print(f"{label}: ❌ not json: {e}")
        print(raw[:240])
        return
    ok=j.get("ok",None)
    filings=j.get("filings",None)
    print(f"{label}: ok={ok} filings_type={type(filings).__name__} filings_len={(len(filings) if isinstance(filings,list) else 'n/a')}")
    if isinstance(filings,list) and filings:
        # show keys of first filing
        f=filings[0]
        if isinstance(f,dict):
            print(f"  first_filing_keys={sorted(list(f.keys()))[:18]}")
            # show its type-ish field
            t=f.get("type") or f.get("filingType") or f.get("filing_type")
            print(f"  first_filing_type_field={t}")
chk("getIncidentBundleV1", sys.stdin.readline())
chk("getIncidentBundle", sys.stdin.readline())
PY <<EOF
$B1
$B2
EOF
echo

# --- check packet zip ---
PKT_URL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID&contractId=$CONTRACT_ID"
echo "==> HEAD packet zip (should be 200)"
curl -fsSI "$PKT_URL" | head -n 25 || { echo "❌ HEAD failed"; tail -n 160 "$LOGDIR/next.log"; exit 1; }
echo

TMP="/tmp/packet_diag_${TS}"
mkdir -p "$TMP"
echo "==> download packet.zip -> $TMP/p.zip"
curl -fsS "$PKT_URL" -o "$TMP/p.zip"

echo "==> zip file list (first 120 lines)"
unzip -l "$TMP/p.zip" | head -n 120
echo

echo "==> grep for filings jsons"
set +e
unzip -l "$TMP/p.zip" | egrep "filings/(dirs|oe417)\.json"
FOUND=$?
set -e
if [[ $FOUND -ne 0 ]]; then
  echo
  echo "❌ filings/dirs.json or filings/oe417.json NOT FOUND in zip"
  echo
  echo "==> show any filings/* present"
  unzip -l "$TMP/p.zip" | egrep "filings/" || true
  echo
  echo "==> show _bundle_error if present"
  unzip -p "$TMP/p.zip" "filings/_bundle_error.json" 2>/dev/null | head -c 800; echo || true
  echo
  echo "==> show route snippet around filingsFromIncident"
  nl -ba next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts | sed -n '140,260p' | sed -n '1,120p'
  echo
  echo "==> tail next.log (last 140)"
  tail -n 140 "$LOGDIR/next.log" || true
  echo
  echo "==> STOP:"
  echo "kill $EMU_PID $NEXT_PID"
  exit 2
else
  echo "✅ filings/dirs.json + filings/oe417.json are present in zip"
fi

echo
echo "✅ DONE - diagnostic passed"
echo "OPEN:"
echo "  $INC_URL"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
