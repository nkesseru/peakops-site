#!/usr/bin/env bash
set -euo pipefail

# zsh users: avoid history expansion surprises if you run this via zsh
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
CONTRACT_ID="${3:-car_abc123}"
VERSION_ID="${4:-v1}"

ROOT="$HOME/peakops/my-app"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> boot_stack_green"
echo "project=$PROJECT_ID org=$ORG_ID contract=$CONTRACT_ID version=$VERSION_ID"
echo

echo "==> (0) hard-kill ports + stray emulators/next"
lsof -tiTCP:3000,5001,8080,8081,4000,4400,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 0.3

echo "==> (1) start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"

echo "==> (2) wait for functions /hello"
for i in $(seq 1 160); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || {
  echo "❌ emulators never came up"
  tail -n 120 "$LOGDIR/emulators.log" || true
  exit 1
}
echo "✅ functions ready"
echo

echo "==> (3) point Next to emulator (FN_BASE + default org)"
ENV_LOCAL="$ROOT/next-app/.env.local"
mkdir -p "$(dirname "$ENV_LOCAL")"
# replace or append
grep -q '^FN_BASE=' "$ENV_LOCAL" 2>/dev/null && sed -i '' "s#^FN_BASE=.*#FN_BASE=$FN_BASE#g" "$ENV_LOCAL" || echo "FN_BASE=$FN_BASE" >> "$ENV_LOCAL"
grep -q '^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=' "$ENV_LOCAL" 2>/dev/null && sed -i '' "s#^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=.*#NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID#g" "$ENV_LOCAL" || echo "NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID" >> "$ENV_LOCAL"
echo "✅ next-app/.env.local set:"
grep -E '^(FN_BASE|NEXT_PUBLIC_DEV_DEFAULT_ORG_ID)=' "$ENV_LOCAL" | sed 's/^/  /'
echo

echo "==> (4) seed Firestore emulator with contract + payloads"
# We seed using firebase-admin from functions_clean so we don't depend on repo root deps.
node <<'NODE'
const path = require('path');

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8081';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || process.env.PROJECT_ID || 'peakops-pilot';

const ROOT = process.env.ROOT_DIR || (process.env.HOME + '/peakops/my-app');
const ORG_ID = process.env.ORG_ID || 'org_001';
const CONTRACT_ID = process.env.CONTRACT_ID || 'car_abc123';
const VERSION_ID = process.env.VERSION_ID || 'v1';

const admin = require(path.join(ROOT, 'functions_clean', 'node_modules', 'firebase-admin'));
try { admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT }); } catch {}

const db = admin.firestore();

async function main() {
  // contract doc
  await db.collection('contracts').doc(CONTRACT_ID).set({
    id: CONTRACT_ID,
    orgId: ORG_ID,
    contractNumber: 'CTR-2025-0001',
    type: 'MSA',
    status: 'ACTIVE',
    customerId: 'cust_acme_001',
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  // payload docs
  const payloadIds = [
    ['v1_baba', 'BABA', 'baba.v1'],
    ['v1_dirs', 'DIRS', 'dirs.v1'],
    ['v1_nors', 'NORS', 'nors.v1'],
    ['v1_oe_417', 'OE_417', 'oe_417.v1'],
    ['v1_sar', 'SAR', 'sar.v1'],
  ];

  for (const [id, type, schemaVersion] of payloadIds) {
    await db.collection('contracts').doc(CONTRACT_ID).collection('payloads').doc(id).set({
      id,
      orgId: ORG_ID,
      contractId: CONTRACT_ID,
      versionId: VERSION_ID,
      type,
      schemaVersion,
      payload: { _placeholder: 'INIT' },
      createdBy: 'seed',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  console.log('✅ seeded contracts/' + CONTRACT_ID + ' + payloads (5 docs)');
}

main().catch(e => {
  console.error('❌ seed failed:', e?.stack || e);
  process.exit(1);
});
NODE
echo "✅ seed done"
echo

echo "==> (5) start Next"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!

echo "==> (6) wait for http://127.0.0.1:3000"
for i in $(seq 1 160); do
  curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1 || {
  echo "❌ next never came up"
  tail -n 120 "$LOGDIR/next.log" || true
  exit 1
}
echo "✅ next ready (pid=$NEXT_PID)"
echo

echo "==> (7) smoke (via Next proxy)"
echo "-- getContractsV1 --"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=5" | head -c 240; echo
echo "-- getContractV1 --"
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | head -c 260; echo
echo "-- getContractPayloadsV1 --"
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | head -c 260; echo
echo

echo "✅ STACK UP"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/packet?orgId=$ORG_ID&versionId=$VERSION_ID"
echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"
