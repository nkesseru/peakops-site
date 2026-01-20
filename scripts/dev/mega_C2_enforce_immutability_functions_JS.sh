#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FUNCS="$ROOT/functions_clean"
[[ -d "$FUNCS" ]] || { echo "❌ functions_clean not found"; exit 1; }

echo "==> locating function JS files"
TL_FILE="$(rg -n --files-with-matches "exports\.generateTimelineV1" "$FUNCS" | head -n 1)"
FL_FILE="$(rg -n --files-with-matches "exports\.generateFilingsV1" "$FUNCS" | head -n 1)"
EX_FILE="$(rg -n --files-with-matches "exports\.exportIncidentPacketV1" "$FUNCS" | head -n 1)"

echo "generateTimelineV1 file: $TL_FILE"
echo "generateFilingsV1 file: $FL_FILE"
echo "exportIncidentPacketV1 file: $EX_FILE"

for f in "$TL_FILE" "$FL_FILE" "$EX_FILE"; do
  [[ -n "$f" ]] || { echo "❌ could not locate one of the function files"; exit 1; }
done

patch_guard () {
  local file="$1"
  cp "$file" "$file.bak_immutable_$(date +%Y%m%d_%H%M%S)"

  python3 - <<PY
from pathlib import Path
import re
p = Path("$file")
s = p.read_text()

if "IMMUTABILITY GUARD" in s:
    print("✅ already guarded:", p)
    raise SystemExit(0)

# Find incident fetch / incidentRef.get() patterns
# We’ll inject guard AFTER incident is loaded (so we have incident.immutable)
# Common: const incidentSnap = await incidentRef.get(); const incident = incidentSnap.data()
m = re.search(r'(const\s+incidentSnap\s*=\s*await\s+incidentRef\.get\(\)\s*;[\s\S]{0,200}?const\s+incident\s*=\s*incidentSnap\.exists\s*\?\s*.*?;\s*)', s)
if not m:
    # fallback: match `const incident =` block
    m = re.search(r'(const\s+incident\s*=\s*.*?;\s*)', s)
if not m:
    raise SystemExit(f"❌ could not find incident load block in {p}")

guard = r'''
    // IMMUTABILITY GUARD
    const force = String(req.query?.force || req.body?.force || "") === "1";
    if (incident?.immutable === true && !force) {
      return res.status(409).json({ ok: false, error: "IMMUTABLE: Incident is finalized" });
    }

'''
s = s[:m.end()] + guard + s[m.end():]
p.write_text(s)
print("✅ injected guard into", p)
PY
}

echo
echo "==> patching functions"
patch_guard "$TL_FILE"
patch_guard "$FL_FILE"
patch_guard "$EX_FILE"

echo
echo "==> restart emulators (functions,firestore)"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true

firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
sleep 6

echo
echo "==> smoke tests (should be 409 unless force=1)"
curl -i -X POST "http://127.0.0.1:3000/api/fn/generateTimelineV1?orgId=org_001&incidentId=inc_TEST" | head -n 18
curl -i -X POST "http://127.0.0.1:3000/api/fn/generateFilingsV1?orgId=org_001&incidentId=inc_TEST" | head -n 18
curl -i "http://127.0.0.1:3000/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST" | head -n 18

echo
echo "==> force override should succeed"
curl -sS -i "http://127.0.0.1:3000/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST&force=1" | head -n 18
