#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"

BASE="http://127.0.0.1:3000"
ZIP_URL="$BASE/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}"

echo "==> (1) Confirm Next routes are up"
curl -sS "$BASE/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 80 || true
echo

echo "==> (2) Pull ZIP headers (source of truth for sha/size)"
HDRS="$(curl -sSI "$ZIP_URL")"
echo "$HDRS" | sed -n '1,25p'
echo

ZIP_SHA="$(echo "$HDRS" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-peakops-zip-sha256"{print $2}' | tail -n 1)"
ZIP_SIZE="$(echo "$HDRS" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-peakops-zip-size"{print $2}' | tail -n 1)"
GEN_AT="$(echo "$HDRS" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-peakops-generatedat"{print $2}' | tail -n 1)"

if [[ -z "${ZIP_SHA}" ]]; then
  echo "❌ Missing x-peakops-zip-sha256 header. Your downloadIncidentPacketZip route isn't emitting headers."
  exit 1
fi
if [[ -z "${ZIP_SIZE}" ]]; then ZIP_SIZE="0"; fi
if [[ -z "${GEN_AT}" ]]; then GEN_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"; fi

echo "zipSha256=$ZIP_SHA"
echo "zipSize=$ZIP_SIZE"
echo "zipGeneratedAt=$GEN_AT"
echo

echo "==> (3) Persist zip verification (server-side) via Next route"
RESP="$(curl -sS -X POST "$BASE/api/fn/persistZipVerificationV1" \
  -H "content-type: application/json" \
  -d "{\"orgId\":\"${ORG_ID}\",\"incidentId\":\"${INCIDENT_ID}\",\"zipSha256\":\"${ZIP_SHA}\",\"zipSize\":${ZIP_SIZE},\"zipGeneratedAt\":\"${GEN_AT}\",\"verifiedBy\":\"ui\"}")"

echo "$RESP" | python3 -m json.tool | head -n 120 || echo "$RESP"
echo

echo "==> (4) Read back zip verification (should be NON-null zipMeta now)"
curl -sS "$BASE/api/fn/getZipVerificationV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 120
echo
