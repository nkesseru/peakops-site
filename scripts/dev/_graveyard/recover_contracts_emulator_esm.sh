#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-$HOME/peakops/my-app}"
cd "$ROOT"

mkdir -p .logs

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
ORG_ID="${ORG_ID:-org_001}"
CONTRACT_ID="${1:-car_abc123}"
CUSTOMER_ID="${2:-cust_acme_001}"
VERSION_ID="${3:-v1}"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"

echo "==> ROOT=$ROOT"
echo "==> PROJECT_ID=$PROJECT_ID"
echo "==> ORG_ID=$ORG_ID"
echo "==> CONTRACT_ID=$CONTRACT_ID"
echo "==> CUSTOMER_ID=$CUSTOMER_ID"
echo "==> VERSION_ID=$VERSION_ID"
echo "==> FN_BASE=$FN_BASE"
echo

echo "==> (0) Kill ports + stray emulators/next"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:5001 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:8081 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true

echo "==> (1) Ensure functions_clean is ESM (package.json main=index.mjs, type=module)"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("functions_clean/package.json")
d = json.loads(p.read_text()) if p.exists() else {}
d["private"] = True
d["type"] = "module"
d["main"] = "index.mjs"

deps = d.get("dependencies", {})
# ensure these exist; versions will be installed/updated by pnpm below
deps.setdefault("firebase-admin", "^12.0.0")
deps.setdefault("firebase-functions", "^4.0.0")
d["dependencies"] = deps

dev = d.get("devDependencies", {})
dev.setdefault("esbuild", "^0.21.0")
d["devDependencies"] = dev

p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ functions_clean/package.json normalized (ESM)")
PY

echo "==> (2) Upgrade deps inside functions_clean"
(
  cd functions_clean
  # IMPORTANT: no --workspace-root (you’re not in a pnpm workspace)
  pnpm add firebase-functions@latest firebase-admin@latest
  pnpm add -D esbuild
)

echo "==> (3) Remove any leftover CJS shim that confuses emulator"
rm -f functions_clean/index.js 2>/dev/null || true

echo "==> (4) Start emulators under Node 20 (no fnm, no nvm required)"
# run firebase CLI under node@20 via npx
# NOTE: logs go to .logs/emulators.log
npx -y -p node@20 -c "firebase emulators:start --only functions,firestore --project $PROJECT_ID" \
  > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> waiting for /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

echo "==> emulator /hello:"
curl -sS "$FN_BASE/hello" | head -c 200; echo

if ! curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
  echo "❌ Functions emulator still not loading. Tail:"
  tail -n 80 .logs/emulators.log
  echo
  echo "Stop:"
  echo "  kill $EMU_PID"
  exit 1
fi

echo "✅ emulators OK (pid=$EMU_PID)"

echo "==> (5) Seed contract doc into emulator Firestore"
node - <<NODE
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
if (!getApps().length) initializeApp({ projectId: "${PROJECT_ID}" });
const db = getFirestore();

await db.collection("contracts").doc("${CONTRACT_ID}").set({
  orgId: "${ORG_ID}",
  contractNumber: "CTR-2025-0001",
  status: "ACTIVE",
  type: "MSA",
  customerId: "${CUSTOMER_ID}",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}, { merge: true });

console.log("✅ seeded emulator: contracts/${CONTRACT_ID}");
NODE

echo "==> (6) Seed payload docs via emulator writeContractPayloadV1"
post () {
  local TYPE="$1"
  local SCHEMA="$2"
  local DOCID="${VERSION_ID}_$(echo "$TYPE" | tr '[:upper:]' '[:lower:]')"
  echo " -> $DOCID ($TYPE / $SCHEMA)"
  curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"contractId\":\"$CONTRACT_ID\",\"type\":\"$TYPE\",\"versionId\":\"$VERSION_ID\",\"schemaVersion\":\"$SCHEMA\",\"payload\":{\"_placeholder\":\"INIT\"},\"createdBy\":\"admin_ui\"}" \
    | python3 -m json.tool | head -n 40
  echo
}

post "BABA"  "baba.v1"
post "DIRS"  "dirs.v1"
post "NORS"  "nors.v1"
post "OE_417" "oe_417.v1"
post "SAR"   "sar.v1"

echo "==> (7) Smoke: getContractPayloadsV1"
curl -sS "$FN_BASE/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 80
echo

echo "==> (8) Start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
  echo "❌ Next didn't come up. Tail:"
  tail -n 80 .logs/next.log
  echo "Stop:"
  echo "  kill $EMU_PID $NEXT_PID"
  exit 1
fi

echo "✅ next OK (pid=$NEXT_PID)"
echo
echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads/v1_dirs?orgId=$ORG_ID"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
