#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

# -----------------------------
# Args
# -----------------------------
PROJECT_ID="${1:-peakops-pilot}"
NEXT_PORT="${2:-3000}"
REGION="${3:-us-central1}"
ORG_ID="org_001"
INCIDENT_ID="inc_TEST"

ROOT="$(git rev-parse --show-toplevel)"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"
cd "$ROOT"

echo "==> repo: $ROOT"
echo "==> PROJECT_ID=$PROJECT_ID REGION=$REGION NEXT_PORT=$NEXT_PORT"

# -----------------------------
# 1. FIX duplicate `force` declarations (root cause)
# -----------------------------
echo
echo "==> Fix duplicate force declarations (functions_clean)"

python3 - <<'PY'
from pathlib import Path
import re

targets = [
    Path("functions_clean/generateTimelineV1.js"),
    Path("functions_clean/generateFilingsV1.js"),
    Path("functions_clean/exportIncidentPacketV1.js"),
]

pat = re.compile(r"^[ \t]*(const|let)[ \t]+force[ \t]*=[^;]+;", re.M)

for p in targets:
    if not p.exists():
        continue
    s = p.read_text()
    matches = list(pat.finditer(s))
    if len(matches) <= 1:
        print(f"✓ {p}: no duplicate force")
        continue

    bkp = p.with_suffix(p.suffix + ".bak_forcefix")
    bkp.write_text(s)

    keep_end = matches[0].end()
    tail = s[keep_end:]
    tail = pat.sub("", tail)
    s2 = s[:keep_end] + tail
    s2 = re.sub(r"\n{3,}", "\n\n", s2)

    p.write_text(s2)
    print(f"✓ {p}: removed {len(matches)-1} duplicate force (backup saved)")
PY

# -----------------------------
# 2. HARD KILL all emulators / ghost ports
# -----------------------------
echo
echo "==> HARD KILL emulator ports"

for p in 5001 8080 4000 4400 4500 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done

pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true
sleep 1

# -----------------------------
# 3. Start Firebase emulators
# -----------------------------
echo
echo "==> Start emulators (functions + firestore)"
rm -f "$LOGDIR/emulators.log"

firebase emulators:start \
  --only functions,firestore \
  --project "$PROJECT_ID" \
  > "$LOGDIR/emulators.log" 2>&1 &

EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for :5001"
for i in $(seq 1 120); do
  lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

# -----------------------------
# 4. Verify functions loaded
# -----------------------------
echo
echo "==> Emulator load check"
if rg -n "SyntaxError:|Failed to load function definition|could not be analyzed" "$LOGDIR/emulators.log" >/dev/null 2>&1; then
  echo "❌ Emulator still broken:"
  tail -n 80 "$LOGDIR/emulators.log"
  echo "STOP: kill $EMU_PID"
  exit 1
fi
echo "✓ Emulator clean"

echo
echo "==> Prove functions exist"
echo "-- hello:"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/hello" | head -c 200 || true
echo
echo "-- getWorkflowV1:"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 200 || true
echo

# -----------------------------
# 5. Write Next env + start Next
# -----------------------------
echo
echo "==> Write next-app/.env.local"

ENVF="next-app/.env.local"
touch "$ENVF"

upsert () {
  local k="$1" v="$2"
  if rg -n "^${k}=" "$ENVF" >/dev/null 2>&1; then
    perl -0777 -i -pe "s/^${k}=.*\$/${k}=${v}/m" "$ENVF"
  else
    printf "%s=%s\n" "$k" "$v" >> "$ENVF"
  fi
}

upsert "NEXT_PUBLIC_ENV" "local"
upsert "FIRESTORE_EMULATOR_HOST" "127.0.0.1:8080"
upsert "FIREBASE_FUNCTIONS_EMULATOR_HOST" "127.0.0.1:5001"
upsert "GCLOUD_PROJECT" "$PROJECT_ID"
upsert "FIREBASE_PROJECT_ID" "$PROJECT_ID"

echo "✓ env written"

echo
echo "==> Start Next"
pkill -f "pnpm dev --port $NEXT_PORT" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
rm -f "$LOGDIR/next.log"

(
  cd next-app
  pnpm dev --port "$NEXT_PORT" > "$LOGDIR/next.log" 2>&1
) &

NEXT_PID=$!
sleep 2

echo "==> Wait for Next"
for i in $(seq 1 120); do
  curl -sS "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1 && break
  sleep 0.25
done

curl -I -sS "http://127.0.0.1:${NEXT_PORT}/" | head -n 5 || true

# -----------------------------
# 6. Smoke checks (THIS is the win condition)
# -----------------------------
echo
echo "==> Smoke: workflow proxy MUST be JSON"
curl -sS -i \
  "http://127.0.0.1:${NEXT_PORT}/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" \
  | head -n 25 || true

echo
echo "==> Smoke: packet ZIP HEAD MUST NOT be 500"
curl -I -sS \
  "http://127.0.0.1:${NEXT_PORT}/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" \
  | head -n 20 || true

# -----------------------------
# 7. Open UI
# -----------------------------
echo
echo "OPEN:"
echo "  Incident: http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  Artifact: http://127.0.0.1:${NEXT_PORT}/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"

# -----------------------------
# 8. Logs + cleanup
# -----------------------------
echo
echo "LOGS:"
echo "  tail -n 200 $LOGDIR/emulators.log"
echo "  tail -n 200 $LOGDIR/next.log"

echo
echo "STOP (when done):"
echo "  kill $EMU_PID $NEXT_PID"
