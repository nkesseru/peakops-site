#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
test -f "$FILE" || { echo "❌ missing: $FILE"; exit 1; }

cp "$FILE" "$FILE.bak_manual_badges_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

m = re.search(r"(const\s+workflowMissingDerived\s*=\s*[^;]+;)", s)
if not m:
    raise SystemExit("❌ Could not find workflowMissingDerived")

if "/*__MANUAL_MODE_DERIVED_STATUS__*/" not in s:
    block = r"""
/*__MANUAL_MODE_DERIVED_STATUS__*/
const hasPacketMeta =
  !!(incident && incident.packetMeta && incident.packetMeta.packetHash);

const effectiveCanonical = workflowMissingDerived
  ? hasPacketMeta
  : Boolean(wf?.steps?.find(s => s.key === "export_packet")?.status === "DONE");

const effectiveImmutable = workflowMissingDerived
  ? Boolean(incident?.immutable === true)
  : Boolean(incident?.immutable === true);

const effectiveZipVerified = workflowMissingDerived
  ? hasPacketMeta
  : Boolean(wf?.steps?.find(s => s.key === "verify_zip")?.status === "DONE");
"""
    s = s[:m.end()] + "\n" + block + s[m.end():]

# Update badgeStyle calls if present (keep changes minimal)
s = re.sub(r"badgeStyle\(\s*incident\.immutable\s*\)", "badgeStyle(effectiveImmutable)", s)
s = re.sub(r"badgeStyle\(\s*packetOk\s*\)", "badgeStyle(effectiveCanonical)", s)
s = re.sub(r"badgeStyle\(\s*zipVerified\s*\)", "badgeStyle(effectiveZipVerified)", s)

p.write_text(s)
print("✅ manual-mode badge fallback applied")
PY

echo "🧹 restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ open"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" 2>/dev/null || true
