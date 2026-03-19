#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/kesserumini/peakops/my-app"
PROJECT_ID="peakops-pilot"
FC="$REPO/functions_clean"

say(){ echo "[boot] $*"; }

cd "$REPO"

say "1) kill firebase-tools + emulator processes"
pkill -f "firebase emulators:start" >/dev/null 2>&1 || true
pkill -f "firebase-tools" >/dev/null 2>&1 || true
pkill -f "emulators:start" >/dev/null 2>&1 || true

# kill Firestore emulator JVM if present
if command -v jps >/dev/null 2>&1; then
  jps -l 2>/dev/null | awk '/CloudFirestore|firestore/{print $1}' | while read -r pid; do
    [[ -n "$pid" ]] && kill -9 "$pid" >/dev/null 2>&1 || true
  done
fi

say "2) kill listeners on common emulator ports"
PORTS=(3001 4005 4415 4505 5004 8087 9154 9199)
for p in "${PORTS[@]}"; do
  pids="$(lsof -nP -iTCP:$p -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u || true)"
  if [[ -n "${pids}" ]]; then
    say "port $p -> pids: ${pids}"
    for pid in ${pids}; do kill -9 "$pid" >/dev/null 2>&1 || true; done
  fi
done
sleep 1

say "3) quarantine functions_clean/.env* so firebase-tools cannot parse them"
QDIR="$FC/.env_quarantine_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$QDIR"
shopt -s nullglob dotglob
for entry in "$FC"/.env*; do
  base="$(basename "$entry")"
  [[ "$entry" == "$QDIR" ]] && continue
  mv "$entry" "$QDIR/$base"
done
shopt -u nullglob dotglob
say "quarantined -> $QDIR"

say "4) export env vars for emulator runtime (NO dotenv files)"
export GCLOUD_PROJECT="$PROJECT_ID"
export FIREBASE_PROJECT_ID="$PROJECT_ID"
export FIREBASE_STORAGE_EMULATOR_HOST="127.0.0.1:9199"
export FIREBASE_STORAGE_BUCKET="${PROJECT_ID}.appspot.com"
export STORAGE_BUCKET="${PROJECT_ID}.appspot.com"
export FUNCTIONS_EMULATOR="true"

say "5) start emulators (functions,firestore,storage) in background"
EMU_LOG="/tmp/peakops_emus_$(date +%Y%m%d_%H%M%S).log"
nohup firebase emulators:start --only functions,firestore,storage --project "$PROJECT_ID" --config firebase.json >"$EMU_LOG" 2>&1 &
sleep 2
say "emulator log: $EMU_LOG"

say "6) wait for /hello"
BASE="http://127.0.0.1:5004/$PROJECT_ID/us-central1"
for _ in $(seq 1 80); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/hello" || true)"
  [[ "$code" == "200" ]] && break
  sleep 0.25
done
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/hello" || true)"
if [[ "$code" != "200" ]]; then
  say "FAIL: hello http=$code"
  tail -n 120 "$EMU_LOG" || true
  exit 1
fi
say "✅ hello is 200"

say "7) start Next dev server"
NEXT_LOG="/tmp/peakops_next_$(date +%Y%m%d_%H%M%S).log"
nohup pnpm -C next-app dev --port 3001 >"$NEXT_LOG" 2>&1 &
sleep 2
say "next log: $NEXT_LOG"

say "8) open app"
echo "open http://127.0.0.1:3001/incidents/inc_demo"
