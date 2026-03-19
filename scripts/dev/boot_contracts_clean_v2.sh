#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ORG_ID="${1:-org_001}"
CONTRACT_ID="${2:-car_abc123}"
VERSION_ID="${3:-v1}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

mkdir -p .logs scripts/dev

echo "==> repo: $ROOT"
echo "==> org: $ORG_ID"
echo "==> contract: $CONTRACT_ID"
echo "==> version: $VERSION_ID"

echo "==> (0) Kill ports + stray dev/emulators"
lsof -tiTCP:3000,5001,8080,8081,4409,4000,4500,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

# ----------------------------
# (1) Force Next to use EMULATOR FN_BASE (not Cloud Run)
# ----------------------------
FN_BASE_EMU="http://127.0.0.1:5001/peakops-pilot/us-central1"
NEXT_ENV="next-app/.env.local"
mkdir -p next-app
touch "$NEXT_ENV"
# overwrite any FN_BASE line
grep -v '^FN_BASE=' "$NEXT_ENV" > "$NEXT_ENV.tmp" || true
mv "$NEXT_ENV.tmp" "$NEXT_ENV"
echo "FN_BASE=$FN_BASE_EMU" >> "$NEXT_ENV"

# optional: default orgId so UI never hard-fails
grep -v '^NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=' "$NEXT_ENV" > "$NEXT_ENV.tmp" || true
mv "$NEXT_ENV.tmp" "$NEXT_ENV"
echo "NEXT_PUBLIC_DEV_DEFAULT_ORG_ID=$ORG_ID" >> "$NEXT_ENV"

echo "✅ next-app/.env.local set:"
tail -n 5 "$NEXT_ENV" | sed 's/.*/  &/'

# ----------------------------
# (2) Patch Next API routes to call the REAL functions that exist in functions_clean
#     (no listContractsV1 — use getContractsV1 + getContractPayloadsV1)
# ----------------------------
echo "==> (1) Patch Next API routes (/api/fn/*) to match functions_clean"
mkdir -p next-app/src/app/api/fn/getContractsV1
cat > next-app/src/app/api/fn/getContractsV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }
  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "getContractsV1");
}
TS

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

mkdir -p next-app/src/app/api/fn/getContractPayloadsV1
cat > next-app/src/app/api/fn/getContractPayloadsV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }
  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "getContractPayloadsV1");
}
TS

# exportContractPacketV1 route (GET)
mkdir -p next-app/src/app/api/fn/exportContractPacketV1
cat > next-app/src/app/api/fn/exportContractPacketV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }
  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "exportContractPacketV1");
}
TS

echo "✅ API routes patched"

# ----------------------------
# (3) Fix AdminNav import paths everywhere (absolute import via app root)
#     We'll use a stable alias: "@/app/admin/_components/AdminNav"
# ----------------------------
echo "==> (2) Ensure tsconfig path alias for @/* exists"
TSCONFIG="next-app/tsconfig.json"
if [ -f "$TSCONFIG" ]; then
  # no-op (assume already has baseUrl paths); we won't hard edit JSON aggressively here
  true
fi

echo "==> (3) Rewrite AdminNav imports to stable absolute path"
python3 - <<'PY'
from pathlib import Path
import re

targets = [
  Path("next-app/src/app/admin/contracts/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/payloads/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/packet/page.tsx"),
]

for p in targets:
  if not p.exists():
    continue
  s = p.read_text()
  # replace any relative AdminNav import with absolute
  s = re.sub(r'import\s+AdminNav\s+from\s+[\'"][^\'"]*AdminNav[\'"];',
             'import AdminNav from "@/app/admin/_components/AdminNav";', s)
  # if AdminNav used but import missing, add it after "use client"
  if "AdminNav" in s and 'import AdminNav' not in s:
    s = s.replace('"use client";\n\n', '"use client";\n\nimport AdminNav from "@/app/admin/_components/AdminNav";\n')
    s = s.replace("'use client';\n\n", "'use client';\n\nimport AdminNav from \"@/app/admin/_components/AdminNav\";\n")
  p.write_text(s)
print("✅ AdminNav imports normalized")
PY

# ----------------------------
# (4) Start emulators
# ----------------------------
echo "==> (4) Start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

echo "==> (5) Wait for functions /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE_EMU/hello" >/dev/null 2>&1; then
    echo "✅ functions ready (pid=$EMU_PID)"
    break
  fi
  sleep 0.25
done

if ! curl -fsS "$FN_BASE_EMU/hello" >/dev/null 2>&1; then
  echo "❌ functions not ready; tailing logs"
  tail -n 120 .logs/emulators.log || true
  exit 1
fi

# ----------------------------
# (5) Start Next
# ----------------------------
echo "==> (6) Start Next dev (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next ready (pid=$NEXT_PID)"
    break
  fi
  sleep 0.25
done

# ----------------------------
# (6) Smoke tests
# ----------------------------
echo "==> (7) Smoke (DIRECT functions)"
curl -sS "$FN_BASE_EMU/getContractsV1?orgId=$ORG_ID&limit=5" | python3 -m json.tool | head -n 40 || true
curl -sS "$FN_BASE_EMU/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | python3 -m json.tool | head -n 40 || true
curl -sS "$FN_BASE_EMU/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 60 || true

echo
echo "==> (8) Smoke (NEXT proxy)"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=5" | python3 -m json.tool | head -n 40 || true
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=$ORG_ID&contractId=$CONTRACT_ID" | python3 -m json.tool | head -n 40 || true
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&limit=50" | python3 -m json.tool | head -n 60 || true

echo
echo "✅ OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/$CONTRACT_ID/packet?orgId=$ORG_ID&versionId=$VERSION_ID"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
