#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
CONFIG="${CONFIG:-firebase.json}"
NEXT_PORT="${NEXT_PORT:-3001}"

# Ports we consistently use
PORTS=(4415 4005 4505 5004 8087 9154 9199)

say() { printf "\n\033[1;36m== %s ==\033[0m\n" "$*"; }
warn() { printf "\033[1;33mWARN: %s\033[0m\n" "$*"; }
fail() { printf "\n\033[1;31mFAIL: %s\033[0m\n" "$*"; exit 1; }

kill_port() {
  local p="$1"
  local pids
  pids="$(lsof -nP -iTCP:${p} -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    warn "Port ${p} in use by PID(s): ${pids}. Killing..."
    for pid in ${pids}; do
      kill -9 "${pid}" 2>/dev/null || true
    done
  fi
}

port_free() {
  local p="$1"
  if lsof -nP -iTCP:${p} -sTCP:LISTEN >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

probe_http() {
  local url="$1"
  curl -sS --max-time 2 -o /dev/null "$url" >/dev/null 2>&1
}

say "1) Killing known port holders (hub/ui/logging/functions/firestore/ws/storage)"
for p in "${PORTS[@]}"; do
  kill_port "$p"
done

say "2) Double-check ports are clear"
for p in "${PORTS[@]}"; do
  if port_free "$p"; then
    echo "FREE $p"
  else
    echo "BUSY $p -> $(lsof -nP -iTCP:${p} -sTCP:LISTEN | tail -n +2 | head -n 1)"
    fail "Port ${p} is still busy. Close the owning terminal/app and rerun."
  fi
done

say "3) Starting Firebase emulators (functions,firestore,storage,ui)"
# Start emulators in background and capture logs
LOG="/tmp/peakops_emulators_mega.log"
rm -f "$LOG"

# Run emulators in background so script can continue
(firebase emulators:start --project "$PROJECT_ID" --config "$CONFIG" --only functions,firestore,storage,ui 2>&1 | tee "$LOG") &
EMU_PID=$!
sleep 2

# Wait until ports are listening (or fail fast)
say "4) Waiting for emulators to become ready"
for i in $(seq 1 30); do
  if lsof -nP -iTCP:5004 -sTCP:LISTEN >/dev/null 2>&1 \
    && lsof -nP -iTCP:8087 -sTCP:LISTEN >/dev/null 2>&1 \
    && lsof -nP -iTCP:9199 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Emulators listening on 5004/8087/9199 ✅"
    break
  fi
  sleep 0.5
done

if ! lsof -nP -iTCP:9199 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "---- emulator log tail ----"
  tail -n 80 "$LOG" || true
  kill -9 "$EMU_PID" 2>/dev/null || true
  fail "Storage emulator (9199) did not start. Check firebase.json storage rules + firebase/storage.rules."
fi

# Probe storage REST
if ! probe_http "http://127.0.0.1:9199/storage/v1/b"; then
  echo "---- emulator log tail ----"
  tail -n 80 "$LOG" || true
  fail "Storage emulator REST probe failed at 9199."
fi
echo "Storage REST probe OK ✅"

say "5) Starting Next dev server (pnpm run next:restart)"
# Run Next restart (assumes your script binds to 3001)
(pnpm run next:restart >/tmp/peakops_next_mega.log 2>&1) &
NEXT_PID=$!
sleep 2

say "6) Waiting for Next to respond on :${NEXT_PORT}"
for i in $(seq 1 40); do
  if curl -sS --max-time 1 "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1; then
    echo "Next is up ✅"
    break
  fi
  sleep 0.5
done
if ! curl -sS --max-time 1 "http://127.0.0.1:${NEXT_PORT}/" >/dev/null 2>&1; then
  echo "---- next log tail ----"
  tail -n 80 /tmp/peakops_next_mega.log || true
  fail "Next did not start on ${NEXT_PORT}."
fi

say "7) Running demo seed"
if [[ -x scripts/dev/seed_demo_incident.sh ]]; then
  scripts/dev/seed_demo_incident.sh
else
  fail "Missing scripts/dev/seed_demo_incident.sh"
fi

say "8) Sanity-check HEIC evidence doc (does it exist in Firestore REST?)"
FS_BASE="http://127.0.0.1:8087/v1/projects/${PROJECT_ID}/databases/(default)/documents"
HEIC_DOC="${FS_BASE}/incidents/inc_demo/evidence_locker/ev_demo_heic_001"

CODE="$(curl -sS -o /tmp/peakops_heic_doc.json -w '%{http_code}' "$HEIC_DOC" || true)"
if [[ "$CODE" != "200" ]]; then
  cat /tmp/peakops_heic_doc.json || true
  warn "HEIC doc not found via Firestore REST (http=$CODE). Seed may have skipped HEIC (storage check)."
else
  echo "HEIC doc exists ✅"
fi

say "DONE ✅"
echo "Open: http://127.0.0.1:${NEXT_PORT}/incidents/inc_demo"
echo "Emulator logs: $LOG"
echo "Next logs: /tmp/peakops_next_mega.log"
echo ""
echo "If HEIC still says storage_emulator_down, you are not actually on this stack."
echo "Confirm UI shows functionsBase=http://127.0.0.1:5004/${PROJECT_ID}/us-central1"
