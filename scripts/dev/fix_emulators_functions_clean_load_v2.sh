#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true   # zsh history expansion off when run via zsh

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
mkdir -p .logs

PROJECT_ID="${1:-peakops-pilot}"

echo "==> hard-kill anything on emulator ports + firebase-tools"
for p in 3000 4000 4400 4500 5001 8080 9150; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "java -jar.*emulator" 2>/dev/null || true

echo "==> write firebase.json (functions source = functions_clean) + pinned ports"
cat > firebase.json <<JSON
{
  "functions": { "source": "functions_clean" },
  "emulators": {
    "functions": { "host": "127.0.0.1", "port": 5001 },
    "firestore": { "host": "127.0.0.1", "port": 8080 },
    "hub": { "host": "127.0.0.1", "port": 4400 },
    "ui": { "host": "127.0.0.1", "port": 4000 },
    "logging": { "host": "127.0.0.1", "port": 4500 }
  }
}
JSON

echo "==> ensure functions_clean/package.json is compatible"
node - <<'NODE'
const fs = require("fs");
const p = "functions_clean/package.json";
if (!fs.existsSync(p)) { console.error("❌ missing " + p); process.exit(1); }
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.engines = j.engines || {};
j.engines.node = "22";                 // EXACT (not >=22)
j.main = j.main || "index.js";
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("✅ patched functions_clean/package.json (engines.node=22, main=index.js)");
NODE

echo "==> install deps in functions_clean (needed for emulator discovery)"
( cd functions_clean && pnpm i --silent ) || ( cd functions_clean && npm i --silent )

echo "==> start emulators (functions + firestore)"
rm -f .logs/emulators.log
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!
sleep 6

echo "==> confirm functions actually loaded"
echo "---- emulators.log (key lines) ----"
grep -nE "Loaded functions definitions|http function initialized|Failed to load function definition|Error:" .logs/emulators.log | tail -n 80 || true
echo "-----------------------------------"

echo "==> HARD PROOF: hit a real function on :5001"
# change this to any function you KNOW exists in functions_clean/index.js exports
curl -sS -i "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/generateTimelineV1?orgId=org_001&incidentId=inc_TEST&requestedBy=direct" | head -n 18 || true

echo
echo "==> Emulator UI (optional): http://127.0.0.1:4000"
echo "==> Logs: tail -n 200 .logs/emulators.log"
echo "==> Stop emulators: kill $EMU_PID"
