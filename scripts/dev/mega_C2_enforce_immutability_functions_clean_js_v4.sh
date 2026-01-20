#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # disable zsh history expansion if invoked from zsh

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
mkdir -p .logs

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

FILES=(
  "functions_clean/generateTimelineV1.js"
  "functions_clean/generateFilingsV1.js"
  "functions_clean/exportIncidentPacketV1.js"
)

echo "==> C2 v4: enforce immutability in functions_clean/*.js"
echo "project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID next_port=$NEXT_PORT"
echo

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "❌ missing file: $f"
    exit 1
  fi
done

# Patch each file with a guard after `incident` is loaded.
python3 - <<'PY'
from pathlib import Path
import re, sys
from datetime import datetime

FILES = [
  "functions_clean/generateTimelineV1.js",
  "functions_clean/generateFilingsV1.js",
  "functions_clean/exportIncidentPacketV1.js",
]

GUARD = r'''
    // IMMUTABILITY_GUARD_V1
    const force = String((req.query && req.query.force) || (req.body && req.body.force) || "") === "1";
    if (incident && incident.immutable === true && !force) {
      return res.status(409).json({ ok: false, error: "IMMUTABLE: Incident is finalized" });
    }

'''

def backup(p: Path):
  ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
  b = p.with_suffix(p.suffix + f".bak_immut_guard_{ts}")
  b.write_text(p.read_text())
  return b

def inject(p: Path):
  s = p.read_text()
  if "IMMUTABILITY_GUARD_V1" in s:
    print(f"✅ already guarded: {p}")
    return

  # Find a safe insertion point AFTER we have `incident`.
  # Prefer: a line containing `.data()` into incident, or `const incident =`
  lines = s.splitlines(keepends=True)

  insert_idx = None

  # 1) After a line that assigns `incident` (best)
  for i, line in enumerate(lines):
    if re.search(r'\bconst\s+incident\s*=', line) or re.search(r'\blet\s+incident\s*=', line):
      insert_idx = i + 1
      break

  # 2) After a `.data()` line (common pattern: incident = incidentSnap.data())
  if insert_idx is None:
    for i, line in enumerate(lines):
      if ".data()" in line and "incident" in line:
        insert_idx = i + 1
        break

  # 3) After an incidentSnap.get() block, then the first `.data()` within next 60 lines
  if insert_idx is None:
    for i, line in enumerate(lines):
      if "incidentSnap" in line and (".get(" in line or "await" in line):
        for j in range(i, min(i + 60, len(lines))):
          if ".data()" in lines[j]:
            insert_idx = j + 1
            break
      if insert_idx is not None:
        break

  if insert_idx is None:
    raise SystemExit(f"❌ could not find insertion point for guard in {p}")

  out = "".join(lines[:insert_idx]) + GUARD + "".join(lines[insert_idx:])
  p.write_text(out)
  print(f"✅ injected guard: {p}")

for fp in FILES:
  p = Path(fp)
  b = backup(p)
  print(f"✅ backup: {b}")
  inject(p)
PY

echo
echo "==> restart emulators (functions + firestore)"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true

firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
sleep 6

echo
echo "==> smoke (should be 409 unless force=1)"
echo "-- generateTimelineV1 (expect 409)"
curl -sS -i -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateTimelineV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=smoke" | head -n 18 || true
echo
echo "-- generateFilingsV1 (expect 409)"
curl -sS -i -X POST "http://127.0.0.1:${NEXT_PORT}/api/fn/generateFilingsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=smoke" | head -n 18 || true
echo
echo "-- exportIncidentPacketV1 (expect 409)"
curl -sS -i "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=smoke" | head -n 18 || true
echo
echo "-- exportIncidentPacketV1 (force=1 should be 200)"
curl -sS -i "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&requestedBy=smoke&force=1" | head -n 18 || true

echo
echo "LOGS:"
echo "  tail -n 200 .logs/emulators.log"
