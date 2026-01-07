#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

echo "==> (0) Kill anything holding ports / emulators"
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:5001 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:8081 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
lsof -tiTCP:4409 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
mkdir -p .logs

echo "==> (1) Force Node 20 for Firebase tools/emulator"
if command -v nvm >/dev/null 2>&1; then
  nvm use 20 >/dev/null
elif command -v fnm >/dev/null 2>&1; then
  fnm use 20
else
  echo "⚠️ No nvm/fnm detected. If you hit ESM issues, install nvm and run: nvm install 20 && nvm use 20"
fi
node -v

echo "==> (2) Rewrite functions_clean/package.json to valid JSON + ESM entry"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("functions_clean/package.json")
data = {
  "name": "functions_clean",
  "private": True,
  "type": "module",
  "main": "index.mjs",
  "engines": {"node": "20"},
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^5.0.0"
  }
}
p.write_text(json.dumps(data, indent=2) + "\n")
print("✅ wrote functions_clean/package.json")
PY

echo "==> (3) Ensure firebase.json points to functions_clean"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("firebase.json")
j = json.loads(p.read_text())
j.setdefault("functions", {})
j["functions"]["source"] = "functions_clean"
p.write_text(json.dumps(j, indent=2) + "\n")
print("✅ patched firebase.json -> functions.source=functions_clean")
PY

echo "==> (4) Start emulators (functions+firestore) in background"
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
echo "==> (5) Wait for /hello"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then
    echo "✅ functions hello OK"
    break
  fi
  sleep 0.25
done

echo "==> (6) Show loaded functions (first 50 lines)"
curl -sS "$FN_BASE/hello" | head -n 5 || true

echo "==> (7) Start Next on :3000 in background"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!
echo "NEXT_PID=$NEXT_PID"

echo "==> (8) Wait for Next :3000"
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ next OK"
    break
  fi
  sleep 0.25
done

echo
echo "✅ STACK UP"
echo "Functions: $FN_BASE"
echo "UI:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo
echo "Logs:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"
