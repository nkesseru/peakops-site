#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app
set -a; source ./.env.dev.local 2>/dev/null || true; set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"
CONTRACT_ID="${1:-car_abc123}"
VERSION_ID="${2:-v1}"
CREATED_BY="${3:-admin_ui}"

echo "==> FN_BASE=$FN_BASE"
echo "==> ORG_ID=$ORG_ID"
echo "==> CONTRACT_ID=$CONTRACT_ID"
echo "==> VERSION_ID=$VERSION_ID"
echo

post () {
  local TYPE="$1"
  local SCHEMA="$2"
  echo "==> writeContractPayloadV1: $TYPE ($SCHEMA)"
  curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{
      \"orgId\":\"$ORG_ID\",
      \"contractId\":\"$CONTRACT_ID\",
      \"type\":\"$TYPE\",
      \"versionId\":\"$VERSION_ID\",
      \"schemaVersion\":\"$SCHEMA\",
      \"payload\": { \"_placeholder\":\"INIT\" },
      \"createdBy\":\"$CREATED_BY\"
    }" | python3 -m json.tool
  echo
}

post "BABA"  "baba.v1"
post "DIRS"  "dirs.v1"
post "NORS"  "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"   "sar.v1"

echo "✅ done"
