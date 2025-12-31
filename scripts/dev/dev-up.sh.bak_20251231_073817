#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"
mkdir -p .logs

# Load dev env vars (exported)
if [ -f "$ROOT/.env.dev.local" ]; then
  set -a
  source "$ROOT/.env.dev.local"
  set +a
fi

: "${ORG_ID:=org_001}"
: "${FN_BASE:=http://127.0.0.1:5001/peakops-pilot/us-central1}"
export NEXT_PUBLIC_PEAKOPS_FN_BASE="$FN_BASE"

PORTS=(3000 3001 3002 5001 8081 4400 4401 4409 4500 4501 4509 9150)
echo "==> dev-up: killing ports: ${PORTS[*]}"
for p in "${PORTS[@]}"; do
  lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null || true
done

rm -f "$ROOT/next-app/.next/dev/lock" 2>/dev/null || true
rm -f "$ROOT/.logs/emu.pid" "$ROOT/.logs/next.pid" 2>/dev/null || true

echo "==> pin firebase.json -> functions_clean"
python3 - <<'PY'
import json
from pathlib import Path
p = Path("firebase.json")
d = json.loads(p.read_text())
d.setdefault("functions", {})
d["functions"]["source"] = "functions_clean"
p.write_text(json.dumps(d, indent=2) + "\n")
print("firebase.json -> functions.source=functions_clean")
PY

echo "==> start emulators (functions, firestore) [background]"
firebase use pilot >/dev/null
# Start emulators (optionally import)
EMU_CMD=(firebase emulators:start --only functions,firestore)
if [ "${IMPORT_DATA:-0}" = "1" ]; then
  EMU_CMD+=(--import ./emulator_data)
fi
("${EMU_CMD[@]}" > .logs/emulators.log 2>&1) &

EMU_PID=$!
echo "$EMU_PID" > .logs/emu.pid

echo "==> wait for functions /hello"
for i in {1..120}; do
  if curl -sSf "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK"
    break
  fi
  sleep 0.25
done

echo "==> smoke: listIncidents"
curl -sSf "$FN_BASE/listIncidents?orgId=$ORG_ID" >/dev/null
echo "✅ functions listIncidents OK"

echo "==> start Next on 3000 [background]"
cd "$ROOT/next-app"
( pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
NEXT_PID=$!
echo "$NEXT_PID" > "$ROOT/.logs/next.pid"

echo "==> wait for Next"
for i in {1..120}; do
  if curl -sSf "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next OK"
    break
  fi
  sleep 0.25
done

echo ""
echo "✅ DEV ENV UP"
echo "   Next:      http://localhost:3000"
echo "   Functions: $FN_BASE"
echo "   OrgId:     $ORG_ID"
echo "   Logs:      $ROOT/.logs/emulators.log | $ROOT/.logs/next.log"
echo ""
echo "Press Ctrl+C to stop cleanly."

trap 'bash scripts/dev/dev-down.sh' INT TERM
wait
