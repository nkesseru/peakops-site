#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
set +H

ORG_ID="${ORG_ID:-org_001}"
CUSTOMER_ID_BASE="${1:-cust_acme}"
COUNT="${2:-5}"
PREFIX="${3:-car}"
VERSION_ID="${4:-v1}"

echo "==> ORG_ID=$ORG_ID COUNT=$COUNT PREFIX=$PREFIX VERSION_ID=$VERSION_ID"

# assumes stack is already up + functions reachable at localhost:5001
FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"

# detect firestore emulator port
FS_PORT=""
for p in 8081 8080; do
  if lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1; then FS_PORT="$p"; break; fi
done
if [[ -z "$FS_PORT" ]]; then
  echo "❌ Firestore emulator not listening on 8080/8081"
  exit 1
fi
export FIRESTORE_EMULATOR_HOST="127.0.0.1:${FS_PORT}"

echo "✅ FIRESTORE_EMULATOR_HOST=$FIRESTORE_EMULATOR_HOST"

seed_one () {
  local i="$1"
  local CONTRACT_ID="${PREFIX}_$(printf '%03d' "$i")"
  local CUSTOMER_ID="${CUSTOMER_ID_BASE}_$(printf '%03d' "$i")"

  echo
  echo "==> seed contract: $CONTRACT_ID customer=$CUSTOMER_ID"

  node - <<NODE
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
if (!getApps().length) initializeApp({ projectId: "peakops-pilot" });
const db = getFirestore();
await db.collection("contracts").doc("${CONTRACT_ID}").set({
  orgId: "${ORG_ID}",
  orgid: "${ORG_ID}",
  contractNumber: "CTR-2025-" + String(${i}).padStart(4,"0"),
  status: "ACTIVE",
  type: "MSA",
  customerId: "${CUSTOMER_ID}",
  updatedAt: new Date().toISOString(),
}, { merge: true });
console.log("✅ wrote contracts/${CONTRACT_ID}");
NODE

  post_payload () {
    local TYPE="$1"
    local SCHEMA="$2"
    echo "   -> $TYPE"
    curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
      -H "Content-Type: application/json" \
      -d "{\"orgId\":\"${ORG_ID}\",\"contractId\":\"${CONTRACT_ID}\",\"type\":\"${TYPE}\",\"versionId\":\"${VERSION_ID}\",\"schemaVersion\":\"${SCHEMA}\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}" \
    | python3 -m json.tool | head -n 20
  }

  post_payload "BABA"   "baba.v1"
  post_payload "DIRS"   "dirs.v1"
  post_payload "NORS"   "nors.v1"
  post_payload "OE_417" "oe_417.v1"
  post_payload "SAR"    "sar.v1"
}

for i in $(seq 1 "$COUNT"); do
  seed_one "$i"
done

echo
echo "✅ DONE seeding $COUNT contracts"
