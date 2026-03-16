#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
NEXT="$ROOT/next-app"

echo "== 1) Kill stale Next on 3001 =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  kill -9 $PIDS || true
fi

echo
echo "== 2) Remove stray duplicate button file if it exists =="
rm -f "$NEXT/src/components/evidence/AddEvidenceButton.tsx'"

echo
echo "== 3) Show actual add-evidence files with quoted paths =="
echo "-- page.tsx --"
sed -n '1,120p' "$NEXT/app/incidents/[incidentId]/add-evidence/page.tsx" || true

echo
echo "-- AddEvidenceClient.tsx (top) --"
sed -n '1,260p' "$NEXT/app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx" || true

echo
echo "-- AddEvidenceButton.tsx --"
sed -n '1,220p' "$NEXT/src/components/evidence/AddEvidenceButton.tsx" || true

echo
echo "== 4) Detect active emulator port =="
EMU_PORT=""
if lsof -iTCP:5002 -sTCP:LISTEN >/dev/null 2>&1; then
  EMU_PORT="5002"
elif lsof -iTCP:5004 -sTCP:LISTEN >/dev/null 2>&1; then
  EMU_PORT="5004"
else
  echo "❌ No functions emulator found on 5002 or 5004"
  exit 1
fi
echo "Using emulator port: $EMU_PORT"

echo
echo "== 5) Force Next config to active emulator port =="
python3 <<PY
from pathlib import Path
files = [
    Path("$NEXT/.env.local"),
    Path("$NEXT/src/lib/functionsBase.ts"),
    Path("$NEXT/app/api/fn/_proxy.ts"),
]
for p in files:
    s = p.read_text()
    s2 = s.replace("127.0.0.1:5002", "127.0.0.1:$EMU_PORT").replace("127.0.0.1:5004", "127.0.0.1:$EMU_PORT")
    if s != s2:
        p.write_text(s2)
        print(f"patched: {p}")
    else:
        print(f"unchanged: {p}")
PY

echo
echo "== 6) Restart Next =="
rm -rf "$NEXT/.next"
(
  cd "$ROOT"
  pnpm dev
) &
sleep 6

echo
echo "== 7) Verify incident API =="
curl -s "http://127.0.0.1:3001/api/fn/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo" || true
echo

echo
echo "== 8) Check whether this incident has jobs =="
curl -s "http://127.0.0.1:3001/api/fn/listJobsV1?orgId=riverbend-electric&incidentId=inc_demo&limit=50&actorUid=dev-admin&actorRole=admin" || true
echo

echo
echo "== 9) Done =="
echo "Open these:"
echo "  http://127.0.0.1:3001/incidents/inc_demo"
echo "  http://127.0.0.1:3001/incidents/inc_demo/add-evidence?orgId=riverbend-electric"
