#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

mkdir -p .logs

echo "==> hard kill old emulators"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "node.*firebase" 2>/dev/null || true

# free the standard ports (best-effort)
for p in 4000 4400 4500 5001 8080 9150; do
  lsof -tiTCP:"$p" -sTCP:LISTEN | xargs -r kill -9 || true
done

echo "==> ensure firebase.json points functions -> functions_clean"
# (this preserves other top-level keys if you already have them; if you want strict, overwrite instead)
python3 - <<'PY'
import json
from pathlib import Path

p = Path("firebase.json")
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text())
    except Exception:
        data = {}

data.setdefault("emulators", {})
data["emulators"].setdefault("functions", {})
data["emulators"].setdefault("firestore", {})
data["emulators"].setdefault("hub", {})
data["emulators"].setdefault("ui", {})
data["emulators"].setdefault("logging", {})

data["emulators"]["functions"].update({"host": "127.0.0.1", "port": 5001})
data["emulators"]["firestore"].update({"host": "127.0.0.1", "port": 8080})
data["emulators"]["hub"].update({"host": "127.0.0.1", "port": 4400})
data["emulators"]["ui"].update({"host": "127.0.0.1", "port": 4000})
data["emulators"]["logging"].update({"host": "127.0.0.1", "port": 4500})

# critical: functions source
data["functions"] = {"source": "functions_clean"}

p.write_text(json.dumps(data, indent=2) + "\n")
print("✅ firebase.json updated (functions source = functions_clean)")
PY

echo "==> ensure functions_clean/package.json engines.node is EXACT 22"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("functions_clean/package.json")
if not p.exists():
    raise SystemExit("❌ functions_clean/package.json missing")

j = json.loads(p.read_text())
j.setdefault("engines", {})
j["engines"]["node"] = "22"
p.write_text(json.dumps(j, indent=2) + "\n")
print("✅ functions_clean/package.json engines.node=22")
PY

echo "==> start emulators"
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
sleep 6

echo "==> confirm functions loaded"
# This line is the money line when it works:
# "Loaded functions definitions from source: ..."
grep -E "Loaded functions definitions|http function initialized|Failed to load function definition" -n .logs/emulators.log | tail -n 30 || true

echo
echo "==> sanity: hit hello + list endpoints via Next"
curl -sS "http://127.0.0.1:5001/peakops-pilot/us-central1/hello" | head -c 120; echo || true
curl -sS -i -X POST "http://127.0.0.1:3000/api/fn/generateTimelineV1?orgId=org_001&incidentId=inc_TEST&requestedBy=smoke" | head -n 18 || true

echo
echo "LOGS:"
echo "  tail -n 200 .logs/emulators.log"
