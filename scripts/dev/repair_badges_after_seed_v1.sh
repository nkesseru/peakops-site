#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # disable zsh history expansion if invoked oddly

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

BASE="http://127.0.0.1:${NEXT_PORT}"

echo "==> repair badges (immutable + zip verified)"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID port=$NEXT_PORT"
echo

echo "==> sanity: Next reachable"
curl -I -sS "$BASE/" | head -n 5 || true
echo

echo "==> (1) lock before"
curl -sS "$BASE/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool || true
echo

echo "==> (2) finalize incident (idempotent)"
curl -sS -X POST "$BASE/api/fn/finalizeIncidentV1" \
  -H "content-type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"immutableBy\":\"repair\",\"immutableReason\":\"repair_after_seed\"}" \
  | python3 -m json.tool || true
echo

echo "==> (3) ensure packet zip exists + get headers"
HDRS="$(mktemp)"
curl -sS -D "$HDRS" -o /dev/null -I \
  "$BASE/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" || true

ZIP_SHA="$(grep -i '^x-peakops-zip-sha256:' "$HDRS" | tail -n 1 | awk '{print $2}' | tr -d '\r')"
ZIP_SIZE="$(grep -i '^x-peakops-zip-size:' "$HDRS"   | tail -n 1 | awk '{print $2}' | tr -d '\r')"
ZIP_GEN="$(grep -i '^x-peakops-generatedat:' "$HDRS" | tail -n 1 | awk '{print $2}' | tr -d '\r')"

# If headers missing, force an export to regenerate zip headers
if [[ -z "${ZIP_SHA}" || -z "${ZIP_SIZE}" || -z "${ZIP_GEN}" ]]; then
  echo "WARN: zip headers missing; forcing export to regenerate"
  curl -sS "$BASE/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=repair&force=1" \
    | head -c 260; echo
  rm -f "$HDRS"
  HDRS="$(mktemp)"
  curl -sS -D "$HDRS" -o /dev/null -I \
    "$BASE/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" || true
  ZIP_SHA="$(grep -i '^x-peakops-zip-sha256:' "$HDRS" | tail -n 1 | awk '{print $2}' | tr -d '\r')"
  ZIP_SIZE="$(grep -i '^x-peakops-zip-size:' "$HDRS"   | tail -n 1 | awk '{print $2}' | tr -d '\r')"
  ZIP_GEN="$(grep -i '^x-peakops-generatedat:' "$HDRS" | tail -n 1 | awk '{print $2}' | tr -d '\r')"
fi

echo "zipSha256=${ZIP_SHA}"
echo "zipSize=${ZIP_SIZE}"
echo "zipGeneratedAt=${ZIP_GEN}"
echo

echo "==> (4) persist zip verification"
curl -sS -X POST "$BASE/api/fn/persistZipVerificationV1" \
  -H "content-type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"zipSha256\":\"${ZIP_SHA}\",\"zipSize\":${ZIP_SIZE:-0},\"zipGeneratedAt\":\"${ZIP_GEN}\",\"verifiedBy\":\"repair\",\"verifiedAt\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" \
  | python3 -m json.tool || true
echo

echo "==> (5) read back truth"
echo "-- lock:"
curl -sS "$BASE/api/fn/getIncidentLockV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool || true
echo
echo "-- zip verification:"
curl -sS "$BASE/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool || true
echo
echo "-- packet meta:"
curl -sS "$BASE/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool || true
echo

echo "OPEN:"
echo "  Incident: $BASE/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  Artifact: $BASE/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
