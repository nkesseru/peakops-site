#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app
if command -v nvm >/dev/null 2>&1; then
  nvm install 20 >/dev/null
  nvm use 20 >/dev/null
elif command -v fnm >/dev/null 2>&1; then
  fnm install 20 >/dev/null
  fnm use 20
else
  echo "❌ Need Node 20 via nvm or fnm. (firebase emulators are choking on Node 22)"
  node -v
  exit 1
fi

echo "✅ node=$(node -v)"
set -a
source ./.env.dev.local 2>/dev/null || true
set +a
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"
echo "FN_BASE=$FN_BASE"
echo "ORG_ID=$ORG_ID"
echo
echo "==> killing stray procs (3000/5001/8081/4409)"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:5001 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:8081 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:4409 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
pkill -f "firebase.*emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "pnpm dev" 2>/dev/null || true
echo "✅ ports cleared"
echo
python3 - <<'PY'
import json
from pathlib import Path
p = Path("functions_clean/package.json")
d = json.loads(p.read_text())
d["type"] = "module"
d["main"] = d.get("main") or "index.mjs"
d.setdefault("engines", {})["node"] = "20"
p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ normalized functions_clean/package.json (type=module, main=index.mjs, node=20)")
PY
echo
echo "==> ESM sanity import (must pass)"
node --input-type=module -e "import('./functions_clean/index.mjs').then(()=>console.log('✅ ESM_IMPORT_OK')).catch(e=>{console.error('❌ ESM_IMPORT_FAIL');console.error(e);process.exit(1)})"
echo
echo "==> start emulators (functions, firestore)"
mkdir -p .logs
firebase emulators:start --only functions,firestore > .logs/emulators.log 2>&1 &
EMU_PID=$!
sleep 2
for i in $(seq 1 40); do
  if curl -sS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions up"
    break
  fi
  sleep 0.5
done
echo
echo "==> start next-app on :3000"
(cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 &) 
NEXT_PID=$!
sleep 2
for i in $(seq 1 40); do
  if curl -sS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next up"
    break
  fi
  sleep 0.5
done
echo
echo "==> smoke: functions getContractsV1"
curl -sS "$FN_BASE/getContractsV1?orgId=$ORG_ID&limit=10" | python3 -m json.tool | head -n 80 || true
echo
echo "==> smoke: next api proxy getContractsV1"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=$ORG_ID&limit=10" | python3 -m json.tool | head -n 80 || true
echo

echo "✅ STACK UP"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=$ORG_ID"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
