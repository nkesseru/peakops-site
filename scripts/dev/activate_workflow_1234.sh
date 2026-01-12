#!/bin/bash
set -euo pipefail

cd ~/peakops/my-app

echo "==> Activating Workflow 1–4 (safe mode)"

FILE="functions_clean/getWorkflowV1.js"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${TS}"
echo "✅ backup: $FILE.bak_${TS}"

python3 <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/getWorkflowV1.js")
s = p.read_text()

if "workflowSpine1234" in s:
    print("⚠️ workflowSpine1234 already present (skipping inject)")
    raise SystemExit(0)

insert = r"""
// --- workflowSpine1234 ---
const baselineOk =
  !!incident &&
  !!incident.orgId &&
  !!incident.id;

const filingsReady = !!incident?.filingsMeta;
const exportReady = filingsReady;

const timeline = [
  { key: "incident_created", label: "Incident created", t: 0 },
  { key: "timeline_ready", label: "Timeline generated", t: 5 },
  { key: "filings_ready", label: "Filings generated", t: 10 },
  { key: "packet_ready", label: "Packet exported", t: 15 },
];

const steps = [
  {
    key: "intake",
    title: "Intake",
    hint: "Confirm incident exists + baseline fields.",
    status: baselineOk ? "DONE" : "TODO",
  },
  {
    key: "timeline",
    title: "Build Timeline",
    hint: "Generate timeline events + verify ordering.",
    status: baselineOk ? "DOING" : "TODO",
  },
  {
    key: "filings",
    title: "Generate Filings",
    hint: "Build DIRS / OE-417 / NORS / SAR payloads.",
    status: filingsReady ? "DONE" : "TODO",
  },
  {
    key: "export",
    title: "Export Packet",
    hint: "Create immutable shareable artifact (ZIP + hashes).",
    status: exportReady ? "DONE" : "TODO",
  },
];
// --- end workflowSpine1234 ---
"""

# inject right before incident is declared
s = s.replace("const incident =", insert + "\nconst incident =", 1)

# ensure response uses the injected objects
s = re.sub(
    r"workflow:\s*\{[\s\S]*?\}",
    """workflow: {
      version: "v1",
      steps,
      timeline,
      filingsReady,
      exportReady,
    }""",
    s,
    count=1
)

p.write_text(s)
print("✅ workflow 1–4 injected")
PY

echo "==> Restarting emulators + Next"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

mkdir -p .logs
firebase emulators:start --only functions,firestore > .logs/emulators.log 2>&1 &
sleep 3
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 3

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> Smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENT PAGE GREEN" || {
  echo "❌ incidents still failing — tail next.log:"
  tail -n 80 .logs/next.log || true
  exit 1
}

echo "🎉 Workflow 1–4 ACTIVE"
echo "OPEN:"
echo "  $URL"
