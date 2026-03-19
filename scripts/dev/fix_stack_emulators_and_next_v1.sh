#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# args:
#   1) projectId OR nextPort (if numeric)
#   2) nextPort (if arg1 was projectId)
PROJECT_ID="peakops-pilot"
NEXT_PORT="3000"

if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  NEXT_PORT="$1"
elif [[ -n "${1:-}" ]]; then
  PROJECT_ID="$1"
  NEXT_PORT="${2:-3000}"
fi

LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> repo: $ROOT"
echo "==> PROJECT_ID=$PROJECT_ID NEXT_PORT=$NEXT_PORT"
echo

echo "==> HARD KILL known dev ports (ghost emulators/next)"
for p in 3000 4000 4400 4500 5001 8080 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "pnpm dev --port ${NEXT_PORT}" 2>/dev/null || true
sleep 1
echo "✅ ports cleared"
echo

echo "==> Ensure firebase.json points to functions_clean (and pins ports)"
# NOTE: we keep this minimal: only set the emulators + functions source.
node - <<NODE
const fs = require("fs");
const p = "firebase.json";
const j = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,"utf8")) : {};
j.functions = j.functions || {};
// If firebase.json uses array form, preserve it; otherwise set simple source.
if (Array.isArray(j.functions)) {
  j.functions = j.functions.map(x => ({...x, source: "functions_clean"}));
} else {
  j.functions.source = "functions_clean";
}
j.emulators = j.emulators || {};
j.emulators.functions = j.emulators.functions || {};
j.emulators.firestore = j.emulators.firestore || {};
j.emulators.hub = j.emulators.hub || {};
j.emulators.ui = j.emulators.ui || {};
j.emulators.logging = j.emulators.logging || {};
j.emulators.functions.host = "127.0.0.1";
j.emulators.functions.port = 5001;
j.emulators.firestore.host = "127.0.0.1";
j.emulators.firestore.port = 8080;
j.emulators.hub.host = "127.0.0.1";
j.emulators.hub.port = 4400;
j.emulators.ui.host = "127.0.0.1";
j.emulators.ui.port = 4000;
j.emulators.logging.host = "127.0.0.1";
j.emulators.logging.port = 4500;

fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\\n");
console.log("✅ firebase.json pinned (functions_clean + ports)");
NODE
echo

echo "==> Ensure functions_clean engines/deps OK"
if [[ -f functions_clean/package.json ]]; then
  node - <<NODE
const fs = require("fs");
const p="functions_clean/package.json";
const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.engines=j.engines||{};
j.engines.node="22";
fs.writeFileSync(p, JSON.stringify(j,null,2)+"\\n");
console.log("✅ functions_clean/package.json engines.node=22");
NODE
  ( cd functions_clean && pnpm i --silent ) || ( cd functions_clean && npm i --silent )
else
  echo "❌ missing functions_clean/package.json"
  exit 1
fi
echo

echo "==> Start emulators (firestore + functions)"
rm -f "$LOGDIR/emulators.log"
firebase emulators:start --only firestore,functions --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for ports 5001 + 8080"
for i in $(seq 1 80); do
  (lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1) && (lsof -tiTCP:8080 -sTCP:LISTEN >/dev/null 2>&1) && break
  sleep 0.25
done

if ! lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ functions emulator not listening on :5001"
  tail -n 120 "$LOGDIR/emulators.log" || true
  exit 1
fi
if ! lsof -tiTCP:8080 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ firestore emulator not listening on :8080"
  tail -n 120 "$LOGDIR/emulators.log" || true
  exit 1
fi
echo "✅ emulators listening"
echo

echo "==> Write Next env (so API routes know emulator hosts)"
ENV_FILE="next-app/.env.local"
mkdir -p next-app
touch "$ENV_FILE"
# idempotent upsert
upsert() {
  local k="$1" v="$2"
  if rg -n "^${k}=" "$ENV_FILE" >/dev/null 2>&1; then
    perl -0777 -i -pe "s/^${k}=.*\$/${k}=${v}/m" "$ENV_FILE"
  else
    printf "%s=%s\\n" "$k" "$v" >> "$ENV_FILE"
  fi
}
upsert "NEXT_PUBLIC_ENV" "local"
upsert "FIRESTORE_EMULATOR_HOST" "127.0.0.1:8080"
upsert "FIREBASE_FUNCTIONS_EMULATOR_HOST" "127.0.0.1:5001"
upsert "GCLOUD_PROJECT" "$PROJECT_ID"
upsert "FIREBASE_PROJECT_ID" "$PROJECT_ID"
echo "✅ wrote $ENV_FILE"
tail -n 10 "$ENV_FILE" || true
echo

echo "==> Start Next"
rm -rf next-app/.next 2>/dev/null || true
rm -f "$LOGDIR/next.log"
( cd next-app && pnpm dev --port "$NEXT_PORT" > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> Wait for Next"
for i in $(seq 1 80); do
  curl -sS "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/" | head -n 5 || true
echo

echo "==> Smoke: workflow proxy must be JSON (even if manual mode)"
curl -sS -i "http://127.0.0.1:${NEXT_PORT}/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -n 25 || true
echo

echo "==> Smoke: packet zip HEAD should NOT be 500"
curl -I -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST" | head -n 25 || true
echo

echo "OPEN:"
echo "  Incident: http://127.0.0.1:${NEXT_PORT}/admin/incidents/inc_TEST?orgId=org_001"
echo "  Artifact: http://127.0.0.1:${NEXT_PORT}/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo
echo "LOGS:"
echo "  tail -n 200 $LOGDIR/emulators.log"
echo "  tail -n 200 $LOGDIR/next.log"
echo
echo "STOP (when done):"
echo "  kill $EMU_PID $NEXT_PID"
