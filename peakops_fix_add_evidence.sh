#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
NEXT="$ROOT/next-app"
FN="$ROOT/functions_clean"

echo "== 1) Verify dirs =="
test -d "$NEXT"
test -d "$FN"

echo "== 2) Force app to use the live emulator port 5002 =="
python3 <<'PY'
from pathlib import Path

root = Path.home() / "peakops/my-app"
files = [
    root / "next-app/.env.local",
    root / "next-app/src/lib/functionsBase.ts",
    root / "next-app/app/api/fn/_proxy.ts",
]

for p in files:
    if not p.exists():
        print(f"skip missing: {p}")
        continue
    s = p.read_text()
    s = s.replace("127.0.0.1:5004", "127.0.0.1:5002")
    p.write_text(s)
    print(f"patched: {p}")
PY

echo "== 3) Remove stray duplicate AddEvidenceButton file if present =="
rm -f "$NEXT/src/components/evidence/AddEvidenceButton.tsx'"

echo "== 4) Seed demo incident into firestore emulator =="
cd "$FN"
FIRESTORE_EMULATOR_HOST=127.0.0.1:8082 node - <<'NODE'
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "peakops-pilot" });
const db = admin.firestore();

(async () => {
  await db.collection("incidents").doc("inc_demo").set({
    orgId: "riverbend-electric",
    incidentId: "inc_demo",
    title: "Riverbend Electric Demo Incident",
    status: "open",
    createdAt: new Date(),
    updatedAt: new Date(),
  }, { merge: true });

  console.log("seeded incidents/inc_demo");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
NODE

echo "== 5) Kill old Next on 3001 =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN || true)"
if [ -n "$PIDS" ]; then
  kill -9 $PIDS || true
fi

echo "== 6) Clear Next cache =="
rm -rf "$NEXT/.next"

echo "== 7) Final verification =="
echo "-- env + proxy refs --"
rg -n "5002|5004|NEXT_PUBLIC_FUNCTIONS_BASE|FUNCTIONS_BASE" \
  "$NEXT/.env.local" \
  "$NEXT/src/lib/functionsBase.ts" \
  "$NEXT/app/api/fn/_proxy.ts" || true

echo
echo "-- function direct smoke --"
curl -s "http://127.0.0.1:5002/peakops-pilot/us-central1/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo" || true

echo
echo
echo "✅ Script finished."
echo "Now start Next again with:"
echo "cd $ROOT && pnpm dev"
