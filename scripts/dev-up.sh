#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

export JAVA_TOOL_OPTIONS="-Xmx512m"
for p in 3000 3001 3002 5001 8081 4400 4500 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
done

firebase use pilot >/dev/null
firebase emulators:start --only functions,firestore --import ./emulator_data >/tmp/peakops_emulators.log 2>&1 &
EMU_PID=$!

# wait for functions to come online
echo "Waiting for functions..."
for i in {1..40}; do
  if curl -s http://127.0.0.1:5001/peakops-pilot/us-central1/hello >/dev/null 2>&1; then
    echo "Functions online ✅"
    break
  fi
  sleep 0.25
done
cd next-app
rm -f .next/dev/lock || true
pnpm dev || true
kill $EMU_PID 2>/dev/null || true
