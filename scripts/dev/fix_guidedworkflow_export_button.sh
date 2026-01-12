#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# If button references exportNow but function missing, add it near other helpers in component.
has_call = "onClick={exportNow}" in s
has_fn = re.search(r"\bfunction\s+exportNow\b|\bconst\s+exportNow\b", s) is not None

if has_call and not has_fn:
    # Find a good insertion point: just before "return (" in GuidedWorkflowPanel
    m = re.search(r"\n\s*return\s*\(\s*\n", s)
    if not m:
        raise SystemExit("❌ Could not find return() to anchor exportNow insertion")

    insert = r'''
  async function exportNow() {
    try {
      setErr?.("") if "setErr" in globals() else None
    except:
      pass
    try {
      // 1) Ask backend to generate packet (idempotent)
      const api =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      await fetch(api, { method: "GET" });

      // 2) Open canonical bundle view
      const bundleUrl =
        `/admin/incidents/${encodeURIComponent(incidentId)}/bundle?orgId=${encodeURIComponent(orgId)}`;
      window.open(bundleUrl, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      // If your component has setErr state, keep this simple:
      try {
        // eslint-disable-next-line no-undef
        setErr(String(e?.message || e));
      } catch {}
    }
  }

'''
    s = s[:m.start()] + "\n" + insert + s[m.start():]
    p.write_text(s)
    print("✅ inserted exportNow() handler")
else:
    print("✅ no exportNow insert needed (either not referenced or already exists)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incident page ok" \
  || { echo "❌ incident page failing"; tail -n 120 .logs/next.log; exit 1; }

echo "✅ DONE"
