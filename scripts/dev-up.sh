#!/usr/bin/env bash
set -euo pipefail

export JAVA_TOOL_OPTIONS="-Xmx512m"

for p in 3000 3001 3002 5001 8081 4400 4500 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
done

# Start emulators
firebase use pilot >/dev/null
firebase emulators:start --only functions,firestore --import ./emulator_data &
EMU_PID=$!

# Start Next
cd next-app
rm -f .next/dev/lock || true
pnpm dev

# If pnpm dev exits, kill emulators
kill $EMU_PID 2>/dev/null || true
