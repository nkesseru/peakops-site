#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # disable history expansion (zsh safety)

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
mkdir -p .logs

TL="functions_clean/generateTimelineV1.js"
FL="functions_clean/generateFilingsV1.js"
EX="functions_clean/exportIncidentPacketV1.js"

for f in "$TL" "$FL" "$EX"; do
  if [[ ! -f "$f" ]]; then
    echo "❌ missing: $f"
    exit 1
  fi
done

echo "==> C2: Enforce immutability inside functions_clean/*.js"
echo "==> files:"
echo "  - $TL"
echo "  - $FL"
echo "  - $EX"
echo

backup_one () {
  local f="$1"
  cp "$f" "$f.bak_immut_guard_$(date +%Y%m%d_%H%M%S)"
  echo "✅ backup: $f.bak_immut_guard_*"
}

patch_one () {
  local f="$1"
  backup_one "$f"

  python3 - <<PY
from pathlib import Path
import re

p = Path("$f")
s = p.read_text()

if "IMMUTABILITY_GUARD_V2" in s:
    print("✅ already patched:", p)
    raise SystemExit(0)

guard = r'''
    // IMMUTABILITY_GUARD_V2
    // Block mutations once incident is finalized unless force=1
    const force =
      String((req.query && req.query.force) || (req.body && req.body.force) || "") === "1";
    if (incident && incident.immutable === true && !force) {
      return res.status(409).json({ ok: false, error: "IMMUTABLE: Incident is finalized" });
    }

'''

# Strategy:
# 1) Find where `incident` is set from Firestore (common patterns)
# 2) Inject guard immediately AFTER that line (so incident exists)
patterns = [
    r'^\s*const\s+incident\s*=\s*incidentSnap\.data\(\)\s*;\s*$',
    r'^\s*const\s+incident\s*=\s*incidentDoc\.data\(\)\s*;\s*$',
    r'^\s*const\s+incident\s*=\s*incidentRef\.data\(\)\s*;\s*$',
    r'^\s*let\s+incident\s*=\s*.*;\s*$',
    r'^\s*const\s+incident\s*=\s*.*;\s*$',
]

lines = s.splitlines(keepends=True)

insert_idx = None
for i, line in enumerate(lines):
    # skip if this is a function export header, we want the first meaningful incident assignment inside handler
    for pat in patterns:
        if re.match(pat, line):
            insert_idx = i + 1
            break
    if insert_idx is not None:
        break

if insert_idx is None:
    # Fallback: find an `incidentSnap` read and inject after the first following line that mentions `.data()`
    for i, line in enumerate(lines):
        if "incidentSnap" in line and ".get(" in line:
            # search next ~30 lines for data()
            for j in range(i, min(i+40, len(lines))):
                if ".data()" in lines[j]:
                    insert_idx = j + 1
                    break
        if insert_idx is not None:
            break

if insert_idx is None:
    raise SystemExit(f"❌ could not find a safe 'incident' assignment point in {p}")

out = "".join(lines[:insert_idx]) + guard + "".join(lines[insert_idx:])
p.write_text(out)
print("✅ injected immutability guard:", p)
PY
}

echo "==> patch timeline/filings/export"
patch_one "$TL"
patch_one "$FL"
patch_one "$EX"
echo

echo "==> restart emulators (functions + firestore)"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true

# Start emulators in background (you can keep your keepalive stack if you prefer)
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
sleep 6

echo "==> smoke tests via Next proxy (should be 409 unless force=1)"
echo "-- generateTimelineV1 (expect 409)"
curl -sS -i -X POST "http://127.0.0.1:3000/api/fn/generateTimelineV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo
echo "-- generateFilingsV1 (expect 409)"
curl -sS -i -X POST "http://127.0.0.1:3000/api/fn/generateFilingsV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo
echo "-- exportIncidentPacketV1 (expect 409)"
curl -sS -i "http://127.0.0.1:3000/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo
echo "-- exportIncidentPacketV1 (force=1 should succeed)"
curl -sS -i "http://127.0.0.1:3000/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST&force=1" | head -n 18 || true
echo

echo "LOGS:"
echo "  tail -n 200 .logs/emulators.log"
