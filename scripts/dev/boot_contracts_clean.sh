#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # avoid zsh history expansion issues if you run from zsh

REPO="$(pwd)"
ORG_ID="${1:-org_001}"
CONTRACT_ID="${2:-car_abc123}"
VERSION_ID="${3:-v1}"

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
NEXT_BASE="http://127.0.0.1:3000"

echo "==> repo: $REPO"
echo "==> org:  $ORG_ID"
echo "==> contract: $CONTRACT_ID"
echo "==> version:  $VERSION_ID"
echo "==> FN_BASE:  $FN_BASE"

mkdir -p .logs scripts/dev

echo "==> (0) Hard kill ports + stray dev"
lsof -tiTCP:3000,5001,8080,8081,4000,4409,4500,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) Patch Next proxy routes to call the TRUE LIST functions"
# Contracts LIST (no contractId required) -> listContractsV1
mkdir -p next-app/src/app/api/fn/getContractsV1
cat > next-app/src/app/api/fn/getContractsV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }
  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "listContractsV1");
}
TS

# Payloads LIST (requires contractId) -> listContractPayloadsV1
mkdir -p next-app/src/app/api/fn/getContractPayloadsV1
cat > next-app/src/app/api/fn/getContractPayloadsV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }
  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "listContractPayloadsV1");
}
TS

# Contract DETAIL -> getContractV1
mkdir -p next-app/src/app/api/fn/getContractV1
cat > next-app/src/app/api/fn/getContractV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }
  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "getContractV1");
}
TS

echo "✅ patched Next routes: getContractsV1->listContractsV1, getContractPayloadsV1->listContractPayloadsV1"

echo "==> (2) Start emulators (functions+firestore) [background]"
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> (3) Wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

echo "==> (4) Start Next (port 3000) [background]"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "$NEXT_BASE" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

echo
echo "==> (5) Smoke (DIRECT functions)"
curl -sS "$FN_BASE/listContractsV1?orgId=$ORG_ID&limit=5" | python3 -m json.tool | head -n 60 || true
echo
curl -sS "$FN_BASE/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | python3 -m json.tool | head -n 60 || true
echo
curl -sS "$FN_BASE/listContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 80 || true

echo
echo "==> (6) Smoke (NEXT proxy)"
curl -sS "$NEXT_BASE/api/fn/getContractsV1?orgId=$ORG_ID&limit=5" | python3 -m json.tool | head -n 60 || true
echo
curl -sS "$NEXT_BASE/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | python3 -m json.tool | head -n 60 || true
echo
curl -sS "$NEXT_BASE/api/fn/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 80 || true

echo
echo "✅ OPEN:"
echo "  $NEXT_BASE/admin/contracts?orgId=$ORG_ID"
echo "  $NEXT_BASE/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  $NEXT_BASE/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  $NEXT_BASE/admin/contracts/$CONTRACT_ID/packet?orgId=$ORG_ID&versionId=$VERSION_ID"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
