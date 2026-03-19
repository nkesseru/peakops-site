#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

mkdir -p .logs

# --- env ---
set -a
source ./.env.dev.local 2>/dev/null || true
set +a

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"
CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/${PROJECT_ID}/us-central1}"

echo "==> PROJECT_ID=$PROJECT_ID"
echo "==> ORG_ID=$ORG_ID"
echo "==> CONTRACT_ID=$CONTRACT_ID"
echo "==> CUSTOMER_ID=$CUSTOMER_ID"
echo "==> VERSION_ID=$VERSION_ID"
echo "==> FN_BASE=$FN_BASE"
echo

echo "==> (1) Kill stray listeners"
for p in 3000 5001 8081 4409 9150; do
  lsof -tiTCP:${p} -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
done

echo "==> (2) Start emulators (functions+firestore) in background"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> (3) Wait for functions /hello"
for i in $(seq 1 80); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK"
    break
  fi
  sleep 0.25
done

echo "==> (4) Start Next on :3000 (next-app) in background"
(
  cd next-app
  pnpm dev --port 3000
) > .logs/next.log 2>&1 &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> (5) Wait for Next :3000"
for i in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next OK"
    break
  fi
  sleep 0.25
done

echo "==> (6) Seed Firestore EMULATOR data (contract + payload docs)"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"

node --input-type=module - <<'NODE'
import crypto from "crypto";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const projectId = process.env.PROJECT_ID || "peakops-pilot";
const orgId = process.env.ORG_ID || "org_001";
const contractId = process.env.CONTRACT_ID || "car_abc123";
const customerId = process.env.CUSTOMER_ID || "cust_acme_001";
const versionId = process.env.VERSION_ID || "v1";

if (!getApps().length) initializeApp({ projectId });
const db = getFirestore();

const now = Timestamp.now();

await db.collection("contracts").doc(contractId).set({
  orgId,
  orgid: orgId, // keep both so old code doesn't choke
  contractNumber: "CTR-2025-0001",
  status: "ACTIVE",
  type: "MSA",
  customerId,
  createdAt: now,
  updatedAt: now,
}, { merge: true });

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

const payloads = [
  ["BABA",   "baba.v1",   `${versionId}_baba`],
  ["DIRS",   "dirs.v1",   `${versionId}_dirs`],
  ["NORS",   "nors.v1",   `${versionId}_nors`],
  ["OE_417", "oe_417.v1", `${versionId}_oe_417`],
  ["SAR",    "sar.v1",    `${versionId}_sar`],
];

for (const [type, schemaVersion, docId] of payloads) {
  const payload = { _placeholder: "INIT" };
  const payloadHash = sha256Hex(JSON.stringify({ type, schemaVersion, payload }));
  await db.collection("contracts").doc(contractId).collection("payloads").doc(docId).set({
    orgId,
    contractId,
    type,
    versionId,
    schemaVersion,
    createdBy: "admin_ui",
    payload,
    payloadHash,
    createdAt: now,
    updatedAt: now,
  }, { merge: true });
}

console.log("✅ seeded emulator:");
console.log(`  contracts/${contractId}`);
console.log(`  contracts/${contractId}/payloads (${payloads.length} docs)`);
NODE

echo "==> (7) Smoke: getContractPayloadsV1 (emulator)"
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 120
echo

echo "✅ UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads/${VERSION_ID}_dirs?orgId=$ORG_ID"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
