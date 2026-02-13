#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

export JAVA_TOOL_OPTIONS="-Xmx512m"
PROJECT_ID="${PROJECT_ID:-peakops-pilot}"
FN_PORT="${FN_PORT:-5002}"
FS_PORT="${FS_PORT:-8085}"
HUB_PORT="${HUB_PORT:-4413}"
UI_PORT="${UI_PORT:-4003}"
LOG_PORT="${LOG_PORT:-4503}"
WS_PORT="${WS_PORT:-9152}"
NEXT_PORT="${NEXT_PORT:-3001}"

for p in "$NEXT_PORT" "$FN_PORT" "$FS_PORT" "$HUB_PORT" "$UI_PORT" "$LOG_PORT" "$WS_PORT"; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
done

firebase emulators:start --project "$PROJECT_ID" --config firebase.json --only functions,firestore,ui >/tmp/peakops_emulators.log 2>&1 &
EMU_PID=$!

# wait for functions to come online
echo "Waiting for functions..."
for i in {1..40}; do
  if curl -s "http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1/hello" >/dev/null 2>&1; then
    echo "Functions online ✅"
    break
  fi
  sleep 0.25
done
cd next-app
rm -f .next/dev/lock || true
NEXT_PUBLIC_ENV=local NEXT_PUBLIC_FUNCTIONS_BASE="http://127.0.0.1:${FN_PORT}/${PROJECT_ID}/us-central1" pnpm dev -- --hostname 127.0.0.1 --port "$NEXT_PORT" || true
kill $EMU_PID 2>/dev/null || true
