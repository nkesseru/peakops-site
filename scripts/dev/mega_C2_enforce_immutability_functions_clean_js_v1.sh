#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

FUNCS="functions_clean"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

TL="$FUNCS/generateTimelineV1.js"
FL="$FUNCS/generateFilingsV1.js"
EX="$FUNCS/exportIncidentPacketV1.js"

for f in "$TL" "$FL" "$EX"; do
  [[ -f "$f" ]] || { echo "❌ missing $f"; exit 1; }
done

stamp() { date +"%Y%m%d_%H%M%S"; }

backup_one () {
  local f="$1"
  cp "$f" "$f.bak_immut_guard_$(stamp)"
  echo "✅ backup: $f.bak_immut_guard_*"
}

patch_one () {
  local f="$1"
  echo "==> patching $f"
  backup_one "$f"

  python3 - <<PY
from pathlib import Path
import re

p = Path("$f")
s = p.read_text()

if "IMMUTABILITY_GUARD_V1" in s:
    print("✅ already guarded")
    raise SystemExit(0)

# We expect these handlers to read Firestore doc inside the function.
# We'll inject guard AFTER incident is loaded (we look for a line that sets `incident =`).
m = re.search(r'(^\\s*const\\s+incident\\s*=.*$)', s, flags=re.MULTILINE)
if not m:
    # fallback: `let incident =`
    m = re.search(r'(^\\s*let\\s+incident\\s*=.*$)', s, flags=re.MULTILINE)

if not m:
    raise SystemExit("❌ could not find incident assignment in " + str(p))

insert_at = m.end()

guard = r"""

  // IMMUTABILITY_GUARD_V1
  const force = String((req.query && req.query.force) || (req.body && req.body.force) || "") === "1";
  if (incident && incident.immutable === true && !force) {
    return res.status(409).json({ ok: false, error: "IMMUTABLE: Incident is finalized" });
  }

"""

out = s[:insert_at] + guard + s[insert_at:]
p.write_text(out)
print("✅ guard injected")
PY
}

patch_one "$TL"
patch_one "$FL"
patch_one "$EX"

echo
echo "==> restart emulators (functions + firestore)"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true

firebase emulators:start --only functions,firestore --project peakops-pilot > "$LOGDIR/emulators.log" 2>&1 &
sleep 6

echo
echo "==> smoke (expect 409 unless force=1) via Next proxy"
echo "-- generateTimelineV1"
curl -sS -i -X POST "http://127.0.0.1:3000/api/fn/generateTimelineV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo
echo "-- generateFilingsV1"
curl -sS -i -X POST "http://127.0.0.1:3000/api/fn/generateFilingsV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo
echo "-- exportIncidentPacketV1 (no force)"
curl -sS -i "http://127.0.0.1:3000/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo
echo "-- exportIncidentPacketV1 (force=1 should succeed)"
curl -sS -i "http://127.0.0.1:3000/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST&force=1" | head -n 18 || true

echo
echo "LOGS:"
echo "  tail -n 200 $LOGDIR/emulators.log"
