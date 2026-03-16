#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
NEXT_DIR="$ROOT/next-app"
FN_DIR="$ROOT/functions_clean"

echo "== 1) sanity check =="
test -d "$NEXT_DIR"
test -d "$FN_DIR"
echo "ROOT=$ROOT"

echo
echo "== 2) force app to use the live emulator ports =="
python3 <<'PY'
from pathlib import Path

files = [
    Path.home() / "peakops/my-app/next-app/.env.local",
    Path.home() / "peakops/my-app/next-app/src/lib/functionsBase.ts",
    Path.home() / "peakops/my-app/next-app/app/api/fn/_proxy.ts",
]

replacements = [
    ("127.0.0.1:5002", "127.0.0.1:5004"),
    ("127.0.0.1:8082", "127.0.0.1:8087"),
]

for p in files:
    if not p.exists():
        print(f"skip missing: {p}")
        continue
    s = p.read_text(encoding="utf-8")
    orig = s
    for a, b in replacements:
        s = s.replace(a, b)
    if p.name == "functionsBase.ts":
        s = s.replace(
            'if (b.includes(":5004/")) return DEV_FALLBACK_FUNCTIONS_BASE;',
            'if (b.includes(":5004/")) return DEV_FALLBACK_FUNCTIONS_BASE;'
        )
        s = s.replace(
            'if (b.includes(":5002/")) return DEV_FUNCTIONS_BASE;',
            'if (b.includes(":5002/")) return DEV_FUNCTIONS_BASE;'
        )
    if s != orig:
        p.write_text(s, encoding="utf-8")
        print(f"patched: {p}")
    else:
        print(f"no changes: {p}")
PY

echo
echo "== 3) show current config =="
rg -n "5004|5002|8087|8082|NEXT_PUBLIC_FUNCTIONS_BASE|FUNCTIONS_BASE" \
  "$NEXT_DIR/.env.local" \
  "$NEXT_DIR/src/lib/functionsBase.ts" \
  "$NEXT_DIR/app/api/fn/_proxy.ts" || true

echo
echo "== 4) verify emulator ports are actually listening =="
echo "-- functions 5004 --"
lsof -iTCP:5004 -sTCP:LISTEN || true
echo "-- firestore 8087 --"
lsof -iTCP:8087 -sTCP:LISTEN || true

echo
echo "== 5) seed demo incident into the LIVE firestore emulator on 8087 =="
cd "$FN_DIR"
FIRESTORE_EMULATOR_HOST=127.0.0.1:8087 node - <<'NODE'
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

  const snap = await db.collection("incidents").doc("inc_demo").get();
  console.log("exists after seed:", snap.exists);
  console.log("data:", snap.exists ? snap.data() : null);
})();
NODE

echo
echo "== 6) verify function sees the incident through 5004 =="
curl -s "http://127.0.0.1:5004/peakops-pilot/us-central1/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo"
echo

echo
echo "== 7) stop only Next on 3001, do NOT kill emulator =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN || true)"
if [ -n "${PIDS:-}" ]; then
  kill -9 $PIDS || true
fi

echo
echo "== 8) clear next cache =="
rm -rf "$NEXT_DIR/.next"

echo
echo "== 9) done =="
echo "Now start Next in a fresh shell with:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  http://127.0.0.1:3001/api/fn/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo"
echo "  http://127.0.0.1:3001/incidents/inc_demo"
echo "  http://127.0.0.1:3001/incidents/inc_demo/add-evidence?orgId=riverbend-electric"
