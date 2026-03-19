#!/usr/bin/env bash
set -euo pipefail

# ---- ALWAYS RUN FROM REPO ROOT ----
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
echo "▶ running from repo root: $ROOT"
set +H 2>/dev/null || true  # zsh safety

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

mkdir -p .logs

FILES=(
  "functions_clean/generateTimelineV1.js"
  "functions_clean/generateFilingsV1.js"
  "functions_clean/exportIncidentPacketV1.js"
)

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "❌ missing file: $f"; exit 1; }
done

backup() {
  local f="$1"
  cp "$f" "$f.bak_immut_C2_$(date +%Y%m%d_%H%M%S)"
  echo "✅ backup: $f.bak_immut_C2_*"
}

patch_file() {
  local f="$1"
  backup "$f"

  python3 - "$f" <<'PY'
import sys, re
from pathlib import Path

path = Path(sys.argv[1])
s = path.read_text()

if "IMMUTABILITY_GUARD_C2" in s:
    print(f"ℹ️ already guarded: {path}")
    raise SystemExit(0)

# Insert guard immediately AFTER the line that fetches the incident snapshot:
# common patterns:
#   const snap = await incidentRef.get();
#   const incidentSnap = await incidentRef.get();
#   const incidentSnap = await incidentRef.get();
m = re.search(r'^\s*const\s+(\w+)\s*=\s*await\s+incidentRef\.get\(\)\s*;\s*$', s, re.MULTILINE)
if not m:
    raise SystemExit(f"❌ could not find `await incidentRef.get()` in {path}")

snap_var = m.group(1)

guard = f"""

    // IMMUTABILITY_GUARD_C2
    const force = String((req.query && req.query.force) || (payload && payload.force) || (req.body && req.body.force) || "") === "1";
    const incident = {snap_var}.exists ? ({snap_var}.data() || {{}}) : {{}};
    if (incident.immutable === true && !force) {{
      return res.status(409).json({{ ok: false, error: "IMMUTABLE: Incident is finalized" }});
    }}

"""

ins = m.end()
out = s[:ins] + guard + s[ins:]
path.write_text(out)
print(f"✅ injected immutability guard into {path} (snap={snap_var})")
PY
}

echo "==> (1) Patch functions_clean handlers"
for f in "${FILES[@]}"; do
  patch_file "$f"
done

echo
echo "==> (2) Restart emulators (functions + firestore)"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true

firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
sleep 6

echo
echo "==> (3) Smoke tests via Next proxy (expect 409 unless force=1)"
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
echo "  tail -n 120 .logs/emulators.log"
