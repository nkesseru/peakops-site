#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true   # disable history expansion (avoids zsh-style "event not found")

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

PORTS=(3000 3001 3002 5001 8081 4400 4401 4500 4501 9150)

echo "==> Killing ports: ${PORTS[*]}"
for p in "${PORTS[@]}"; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
done

mkdir -p .logs
rm -f next-app/.next/dev/lock 2>/dev/null || true

export NEXT_PUBLIC_PEAKOPS_FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"

echo "==> Pin firebase.json functions.source=functions_clean"
python3 - <<'PY'
import json
from pathlib import Path
p = Path("firebase.json")
d = json.loads(p.read_text())
d.setdefault("functions", {})
d["functions"]["source"] = "functions_clean"
p.write_text(json.dumps(d, indent=2) + "\n")
print("firebase.json pinned")
PY

echo "==> Starting emulators (functions,firestore) ..."
firebase use pilot >/dev/null

# Run emulators in background and log output
( firebase emulators:start --only functions,firestore --import ./emulator_data > .logs/emulators.log 2>&1 ) &
EMU_PID=$!

cleanup() {
  echo ""
  echo "==> Clean shutdown..."
  kill -9 "$NEXT_PID" 2>/dev/null || true
  kill -9 "$EMU_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "==> Waiting for Functions endpoint..."
for i in {1..80}; do
  if curl -sSf "$NEXT_PUBLIC_PEAKOPS_FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ Functions hello OK"
    break
  fi
  sleep 0.25
done

# Hard fail if hello still not good
if ! curl -sSf "$NEXT_PUBLIC_PEAKOPS_FN_BASE/hello" >/dev/null; then
  echo "❌ Functions not responding (hello). Tail emulators log:"
  tail -n 120 .logs/emulators.log || true
  exit 1
fi

# Smoke test listIncidents
if ! curl -sSf "$NEXT_PUBLIC_PEAKOPS_FN_BASE/listIncidents?orgId=org_001" >/dev/null; then
  echo "❌ listIncidents failing. Tail emulators log:"
  tail -n 160 .logs/emulators.log || true
  exit 1
fi
echo "✅ Emulators healthy."

echo "==> Starting Next on 3000..."
cd "$ROOT/next-app"
( pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
NEXT_PID=$!

# Wait for Next to respond
for i in {1..60}; do
  if curl -sSf "http://127.0.0.1:3000/" >/dev/null 2>&1; then
    echo "✅ Next responding"
    break
  fi
  sleep 0.25
done

echo ""
echo "✅ Dev environment is UP"
echo "   Next:      http://localhost:3000"
echo "   Functions: $NEXT_PUBLIC_PEAKOPS_FN_BASE"
echo "   Logs:      $ROOT/.logs/emulators.log | $ROOT/.logs/next.log"
echo ""
echo "Press Ctrl+C to stop cleanly."
wait
