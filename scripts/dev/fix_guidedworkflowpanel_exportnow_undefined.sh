#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

if [ ! -f "$FILE" ]; then
  echo "❌ missing file: $FILE"
  exit 1
fi

cp "$FILE" "scripts/dev/_bak/GuidedWorkflowPanel.tsx.bak_${TS}"
echo "✅ backup: scripts/dev/_bak/GuidedWorkflowPanel.tsx.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# If exportNow is already defined, do nothing.
if re.search(r'\b(const|function)\s+exportNow\b', s):
    print("✅ exportNow already defined — no patch needed")
    raise SystemExit(0)

# Only patch if the file references exportNow somewhere (button/etc).
if "exportNow" not in s:
    print("⚠️ exportNow not referenced in file — nothing to patch")
    raise SystemExit(0)

# Insert exportNow right before the FIRST "return (" inside the default component.
# This keeps it in component scope and avoids the runtime ReferenceError.
m = re.search(r'\n(\s*)return\s*\(\s*\n', s)
if not m:
    raise SystemExit("❌ Could not find component `return (` to anchor insert")

indent = m.group(1)

insert = f"""
{indent}// --- exportNow: best-effort export + always open bundle page ---
{indent}const exportNow = async () => {{
{indent}  try {{
{indent}    setBusy(true);
{indent}    setErr("");
{indent}
{indent}    const api =
{indent}      `/api/fn/exportIncidentPacketV1?orgId=${{encodeURIComponent(orgId)}}` +
{indent}      `&incidentId=${{encodeURIComponent(incidentId)}}`;
{indent}
{indent}    const r = await fetch(api, {{ method: "GET" }});
{indent}    const txt = await r.text().catch(() => "");
{indent}
{indent}    // If backend returns JSON ok:false, surface it. Otherwise ignore.
{indent}    try {{
{indent}      const j = JSON.parse(txt || "{{}}");
{indent}      if (j?.ok === false) setErr(String(j?.error || "exportIncidentPacketV1 failed"));
{indent}    }} catch {{
{indent}      // ignore non-JSON (Next HTML error etc)
{indent}    }}
{indent}
{indent}    // Always open bundle page (canonical artifact view)
{indent}    const bundleUrl =
{indent}      `/admin/incidents/${{encodeURIComponent(incidentId)}}/bundle?orgId=${{encodeURIComponent(orgId)}}`;
{indent}    if (typeof window !== "undefined") {{
{indent}      window.open(bundleUrl, "_blank", "noopener,noreferrer");
{indent}    }}
{indent}  }} catch (e: any) {{
{indent}    setErr(String(e?.message || e));
{indent}  }} finally {{
{indent}    setBusy(false);
{indent}  }}
{indent}}};
"""

s2 = s[:m.start()] + "\n" + insert + s[m.start():]
p.write_text(s2)
print("✅ patched: inserted exportNow() in component scope")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENTS PAGE GREEN" || {
  echo "❌ still failing — tail next.log"
  tail -n 160 .logs/next.log || true
  exit 1
}

echo "✅ exportNow is now defined (no more ReferenceError)."
