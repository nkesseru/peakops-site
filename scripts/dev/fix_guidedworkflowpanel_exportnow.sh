#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

WF="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

cp "$WF" "scripts/dev/_bak/GuidedWorkflowPanel_exportNow_${ts}.tsx"
echo "✅ backup: $WF -> scripts/dev/_bak/GuidedWorkflowPanel_exportNow_${ts}.tsx"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# Only patch if exportNow is referenced AND not defined
if "onClick={exportNow}" not in s and "onClick=(exportNow)" not in s:
    print("⚠️ No exportNow click handler found. Nothing to patch.")
    raise SystemExit(0)

if re.search(r'\bfunction\s+exportNow\s*\(', s) or re.search(r'\bconst\s+exportNow\s*=\s*\(', s):
    print("✅ exportNow already defined. Nothing to patch.")
    raise SystemExit(0)

# Find a safe place to insert: after load() function, before first useEffect (common in this file)
m = re.search(r'\n\s*async\s+function\s+load\s*\(\)\s*\{[\s\S]*?\n\s*\}\n', s)
if not m:
    # fallback: insert before return (
    m = re.search(r'\n\s*return\s*\(\n', s)
    if not m:
        raise SystemExit("❌ Could not find insertion point (load() or return()).")

insert_at = m.end()

insert = r'''

  // --- Export: generate packet + open bundle view (safe) ---
  async function exportNow() {
    try {
      // Best-effort: trigger backend export (doesn't matter if it fails in dev)
      setBusy(true);
      setErr("");

      const api =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(api, { method: "GET" });
      const txt = await r.text().catch(() => "");

      // If backend returns JSON ok:false, surface it. Otherwise ignore.
      try {
        const j = JSON.parse(txt || "{}");
        if (j?.ok === false) setErr(String(j?.error || "exportIncidentPacketV1 failed"));
      } catch {
        // ignore non-JSON (Next HTML error etc)
      }

      // Always open bundle page (your canonical artifact view)
      const bundleUrl =
        `/admin/incidents/${encodeURIComponent(incidentId)}/bundle?orgId=${encodeURIComponent(orgId)}`;
      window.open(bundleUrl, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

'''

s = s[:insert_at] + insert + s[insert_at:]
p.write_text(s)
print("✅ patched GuidedWorkflowPanel: added exportNow()")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ INCIDENTS PAGE GREEN" || {
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
}

echo "✅ exportNow fixed + bundle open wired"
