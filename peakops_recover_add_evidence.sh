#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
NEXT="$ROOT/next-app"
FN="$ROOT/functions_clean"

echo "== 1) verify dirs =="
test -d "$ROOT"
test -d "$NEXT"
test -d "$FN"

echo "== 2) kill dev servers + emulator ports =="
pkill -f "next dev --hostname 127.0.0.1 --port 3001" 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "functions-framework" 2>/dev/null || true
pkill -f "Cloud Firestore Emulator" 2>/dev/null || true
pkill -f "java.*firestore" 2>/dev/null || true

for p in 3001 4000 4002 4400 4401 4412 4500 4501 4502 5002 5004 8082 8087 9150 9154; do
  PIDS="$(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    kill -9 $PIDS 2>/dev/null || true
  fi
done

echo "== 3) force app config to functions on :5002 =="
python3 <<'PY'
from pathlib import Path

root = Path.home() / "peakops/my-app"
files = [
    root / "next-app/.env.local",
    root / "next-app/src/lib/functionsBase.ts",
    root / "next-app/app/api/fn/_proxy.ts",
]

for p in files:
    s = p.read_text()
    s2 = s.replace("127.0.0.1:5004", "127.0.0.1:5002")
    if s != s2:
        p.write_text(s2)
        print(f"patched: {p}")
    else:
        print(f"ok: {p}")
PY

echo "== 4) remove stray duplicate evidence button file if present =="
rm -f "$NEXT/src/components/evidence/AddEvidenceButton.tsx'"

echo "== 5) nuke next build cache =="
rm -rf "$NEXT/.next"
find "$NEXT" -name "*.tsbuildinfo" -delete 2>/dev/null || true

echo "== 6) start firestore + functions emulators fresh =="
(
  cd "$FN"
  firebase emulators:start --project peakops-pilot --only functions,firestore
) > "$ROOT/.emulators.log" 2>&1 &
EMU_PID=$!

echo "emulators pid: $EMU_PID"
echo "waiting for emulators..."
for i in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:5002/peakops-pilot/us-central1/hello" >/dev/null 2>&1; then
    echo "functions emulator is up"
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:5002/peakops-pilot/us-central1/hello" >/dev/null 2>&1; then
  echo "❌ emulator did not come up. tailing log:"
  tail -n 120 "$ROOT/.emulators.log" || true
  exit 1
fi

echo "== 7) seed demo incident into firestore emulator =="
(
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

  const snap = await db.collection("incidents").doc("inc_demo").get();
  console.log("exists after seed:", snap.exists);
  console.log("data:", snap.exists ? snap.data() : null);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
)

echo "== 8) verify function direct =="
curl -fsS "http://127.0.0.1:5002/peakops-pilot/us-central1/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo"
echo

echo "== 9) start next with webpack (not turbopack) =="
(
  cd "$NEXT"
  pnpm next dev --hostname 127.0.0.1 --port 3001 --webpack
) > "$ROOT/.next.log" 2>&1 &
NEXT_PID=$!

echo "next pid: $NEXT_PID"
echo "waiting for next..."
for i in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:3001/api/fn/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo" >/dev/null 2>&1; then
    echo "next app is up"
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:3001/api/fn/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo" >/dev/null 2>&1; then
  echo "❌ next app did not come up cleanly"
  echo "--- .next.log ---"
  tail -n 120 "$ROOT/.next.log" || true
  echo "--- .emulators.log ---"
  tail -n 120 "$ROOT/.emulators.log" || true
  exit 1
fi

echo "== 10) final smoke =="
curl -fsS "http://127.0.0.1:3001/api/fn/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo"
echo
echo
echo "✅ Recovery complete."
echo "Open:"
echo "  http://127.0.0.1:3001/incidents/inc_demo"
echo "Logs:"
echo "  tail -f $ROOT/.next.log"
echo "  tail -f $ROOT/.emulators.log"
