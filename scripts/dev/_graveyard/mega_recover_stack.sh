#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

echo "==> (0) Load env"
set -a
source ./.env.dev.local 2>/dev/null || true
set +a

FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

echo "FN_BASE=$FN_BASE"
echo "ORG_ID=$ORG_ID"
echo

echo "==> (1) Kill stray dev processes"
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true
pkill -f "node .*next.*dev" 2>/dev/null || true

for p in 3000 3001 3002 5001 8081 4400 4401 4409 4500 4501 4509 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
done

echo "✅ cleaned ports/procs"
echo

echo "==> (2) Force functions_clean to be ESM (prevents 'Unexpected token export')"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("functions_clean/package.json")
d = {}
if p.exists():
  try:
    d = json.loads(p.read_text())
  except Exception:
    d = {}

# hard requirements for .mjs + firebase v2/https
d["name"] = d.get("name","functions_clean")
d["private"] = True
d["type"] = "module"
d["main"] = "index.mjs"
d.setdefault("engines", {})
d["engines"]["node"] = "20"

deps = d.setdefault("dependencies", {})
deps.setdefault("firebase-admin", "^12.7.0")
deps.setdefault("firebase-functions", "^6.0.0")

p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ functions_clean/package.json normalized:", p)
PY
echo

echo "==> (3) ESM import sanity (must pass)"
node -e "import('./functions_clean/index.mjs').then(()=>console.log('✅ ESM_IMPORT_OK')).catch(e=>{console.error('❌ ESM_IMPORT_FAIL'); console.error(e); process.exit(1);})"
echo

echo "==> (4) Start emulators (functions+firestore) in background"
mkdir -p .logs
( firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 ) &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> (5) Wait for functions to come up"
for i in $(seq 1 40); do
  if curl -sS "$FN_BASE/hello" | grep -q "ok"; then
    echo "✅ functions hello OK"
    break
  fi
  sleep 0.5
done

echo "==> (6) Start Next on 3000 in background"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> (7) Wait for Next to come up"
for i in $(seq 1 60); do
  if curl -sS "http://localhost:3000" >/dev/null 2>&1; then
    echo "✅ next OK"
    break
  fi
  sleep 0.5
done

echo
echo "==> (8) Smoke: getContractsV1 via emulator + via Next route"
echo "-- emulator:"
curl -sS "$FN_BASE/getContractsV1?orgId=$ORG_ID&limit=50" | python3 -m json.tool | head -n 60 || true
echo
echo "-- next route:"
curl -sS "http://localhost:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=50" | python3 -m json.tool | head -n 60 || true
echo

echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=$ORG_ID"
echo
echo "Logs:"
echo "  tail -n 80 .logs/emulators.log"
echo "  tail -n 80 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
