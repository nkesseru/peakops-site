#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# If exportNow already exists, do nothing
if re.search(r'\basync function exportNow\b|\bfunction exportNow\b', s):
    print("ℹ️ exportNow already exists — no change.")
    raise SystemExit(0)

# We will insert exportNow inside the component, after setStatus() if possible.
export_fn = r'''
  async function exportNow() {
    try {
      setBusy(true);
      setErr("");

      // Generate/refresh the incident packet server-side (idempotent)
      const url =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(url, { method: "GET" });
      const text = await r.text();
      if (!text || !text.trim()) throw new Error(`Export API returned empty body (HTTP ${r.status})`);

      const parsed = safeParseJson(text);
      if (!parsed.ok) {
        const sample = text.slice(0, 160).replace(/\s+/g, " ");
        throw new Error(`Export API returned non-JSON (HTTP ${r.status}): ${parsed.error} — ${sample}`);
      }

      const j = parsed.value;
      if (j?.ok === false) throw new Error(String(j?.error || "exportIncidentPacketV1 failed"));

      // Mark export as DONE locally (auto-advance will also do this, but this is instant UX)
      try { setStatus("export", "DONE"); } catch {}

      // Open the bundle view (read-only) in same tab
      const bundleUrl =
        `/admin/incidents/${encodeURIComponent(incidentId)}/bundle?orgId=${encodeURIComponent(orgId)}`;
      window.location.href = bundleUrl;

    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
'''.strip("\n")

# Prefer inserting after setStatus() definition
m = re.search(r'\n\s*function\s+setStatus\s*\([^\)]*\)\s*\{[\s\S]*?\n\s*\}\n', s)
if m:
    insert_at = m.end()
    s = s[:insert_at] + "\n\n" + export_fn + "\n" + s[insert_at:]
    p.write_text(s)
    print("✅ inserted exportNow() after setStatus()")
    raise SystemExit(0)

# Fallback: insert before the first "return (" inside component
m2 = re.search(r'\n\s*return\s*\(\s*\n', s)
if not m2:
    raise SystemExit("❌ Could not find insertion point (no return() found). Open the file and paste exportNow manually.")

s = s[:m2.start()] + "\n\n" + export_fn + "\n\n" + s[m2.start():]
p.write_text(s)
print("✅ inserted exportNow() before return()")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ incidents page loads"
else
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
fi

echo "✅ DONE"
