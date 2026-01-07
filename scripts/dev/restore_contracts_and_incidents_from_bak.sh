#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

C_FILE="next-app/src/app/admin/contracts/[id]/page.tsx"
I_FILE="next-app/src/app/admin/incidents/[id]/page.tsx"

echo "==> Finding latest backups..."
C_BAK="$(ls -1t scripts/dev/_bak/contracts_id_page.*.bak 2>/dev/null | head -n 1 || true)"
I_BAK="$(ls -1t scripts/dev/_bak/incidents_id_page.*.bak 2>/dev/null | head -n 1 || true)"

echo "contracts backup: ${C_BAK:-NONE}"
echo "incidents backup: ${I_BAK:-NONE}"

if [ -z "${C_BAK}" ] || [ -z "${I_BAK}" ]; then
  echo "❌ Missing one or both backups in scripts/dev/_bak/"
  echo "List what we have:"
  ls -la scripts/dev/_bak || true
  exit 1
fi

echo "==> Restoring backups..."
cp "$C_BAK" "$C_FILE"
cp "$I_BAK" "$I_FILE"
echo "✅ restored:"
echo "  $C_FILE"
echo "  $I_FILE"

echo "==> Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> Smoke compile (hit pages)"
set +e
curl -fsS "http://127.0.0.1:3000/admin/contracts?orgId=org_001" >/dev/null; A=$?
curl -fsS "http://127.0.0.1:3000/admin/contracts/car_abc123?orgId=org_001" >/dev/null; B=$?
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null; C=$?
set -e

if [ "$A" -eq 0 ] && [ "$B" -eq 0 ] && [ "$C" -eq 0 ]; then
  echo "✅ BACK TO GREEN (compiles)"
  echo "OPEN:"
  echo "  http://localhost:3000/admin/contracts?orgId=org_001"
  echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
  echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
else
  echo "❌ Still failing. First parser error:"
  awk 'BEGIN{p=0} /Parsing ecmascript source code failed/{p=1} p{print} NR>1 && p && /^$/{exit}' .logs/next.log | head -n 80
  exit 1
fi
