#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="functions_clean/generateTimelineV1.js"
[[ -f "$FILE" ]] || { echo "❌ missing: $FILE"; exit 1; }

cp "$FILE" "$FILE.bak_immut_guard_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $FILE.bak_immut_guard_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/generateTimelineV1.js")
s = p.read_text()

if "IMMUTABILITY_GUARD_V1" in s:
    print("ℹ️ already guarded")
    raise SystemExit(0)

needle = "const snap = await incidentRef.get();"
idx = s.find(needle)
if idx < 0:
    raise SystemExit("❌ could not find incidentRef.get() line")

insert_at = idx + len(needle)

guard = r'''

    // IMMUTABILITY_GUARD_V1
    const incident = snap.exists ? (snap.data() || {}) : {};
    const force = String((req.query && req.query.force) || (payload && payload.force) || "") === "1";
    if (incident.immutable === true && !force) {
      return res.status(409).json({ ok: false, error: "IMMUTABLE: Incident is finalized" });
    }
'''
s = s[:insert_at] + guard + s[insert_at:]
p.write_text(s)
print("✅ injected immutability guard into generateTimelineV1.js")
PY

echo "🔁 restart emulators (functions + firestore)"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true

mkdir -p .logs
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
sleep 6

echo "✅ smoke (expect 409 when immutable)"
curl -sS -i -X POST "http://127.0.0.1:3000/api/fn/generateTimelineV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo "LOGS: tail -n 80 .logs/emulators.log"
