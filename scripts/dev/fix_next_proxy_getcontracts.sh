#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(pwd)"
NEXT_APP="$REPO_ROOT/next-app"

echo "==> (1) Patch Next API proxy routes to point to the correct function names"

python3 - <<'PY'
from pathlib import Path

pairs = [
  ("next-app/src/app/api/fn/getContractsV1/route.ts", "getContractsV1"),
  ("next-app/src/app/api/fn/getContractV1/route.ts", "getContractV1"),
  ("next-app/src/app/api/fn/getContractPayloadsV1/route.ts", "getContractPayloadsV1"),
  ("next-app/src/app/api/fn/writeContractPayloadV1/route.ts", "writeContractPayloadV1"),
  ("next-app/src/app/api/fn/exportContractPacketV1/route.ts", "exportContractPacketV1"),
  ("next-app/src/app/api/fn/listContractsV1/route.ts", "getContractsV1"),            # list route should hit getContractsV1
  ("next-app/src/app/api/fn/listContractPayloadsV1/route.ts", "getContractPayloadsV1"),# list route should hit getContractPayloadsV1
]

for rel, fn in pairs:
  p = Path(rel)
  if not p.exists():
    continue

  s = p.read_text()

  # Find proxyGET/proxyPOST call target string and force it to the right fn name.
  # Works for: proxyGET(req, "X"), proxyPOST(req, "X")
  import re
  def repl(m):
    return f'{m.group(1)}{fn}{m.group(3)}'

  s2 = re.sub(r'(proxyGET\(\s*req\s*,\s*")([^"]+)("\s*\))', repl, s)
  s2 = re.sub(r"(proxyGET\(\s*req\s*,\s*')([^']+)('\s*\))", repl, s2)
  s2 = re.sub(r'(proxyPOST\(\s*req\s*,\s*")([^"]+)("\s*\))', repl, s2)
  s2 = re.sub(r"(proxyPOST\(\s*req\s*,\s*')([^']+)('\s*\))", repl, s2)

  if s2 != s:
    p.write_text(s2)
    print("✅ patched", p)
  else:
    print("ℹ️ no change needed", p)

PY

echo
echo "==> (2) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo
echo "==> (3) Smoke tests"
curl -sS "http://127.0.0.1:3000/api/fn/getContractsV1?orgId=org_001&limit=5" | python3 -m json.tool | head -n 40
echo
curl -sS "http://127.0.0.1:3000/api/fn/getContractV1?orgId=org_001&contractId=car_abc123" | python3 -m json.tool | head -n 40
echo
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=org_001&contractId=car_abc123&limit=10" | python3 -m json.tool | head -n 60
echo
echo "✅ If getContractsV1 shows ok:true and docs, you're back in business."
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
