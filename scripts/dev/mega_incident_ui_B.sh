#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$PAGE" || { echo "❌ Missing: $PAGE"; exit 1; }

cp "$PAGE" "$PAGE.bak_uiB_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_uiB_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# If there's already a "Guided Workflow" section, we inject buttons there.
# Otherwise, we add a minimal block near the top of the page component render.
if "Field Actions" in s:
    print("ℹ️ Field Actions already present, skipping insert.")
    raise SystemExit(0)

block = r'''
      <div style={{ marginTop: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", borderRadius: 14, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 950 }}>Field Actions</div>
          {immutable && (
            <div style={{ fontSize: 12, fontWeight: 900, padding: "6px 10px", borderRadius: 999, background: "rgba(34,197,94,0.18)", border: "1px solid rgba(34,197,94,0.35)" }}>
              ✅ FINALIZED (Immutable)
            </div>
          )}
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button disabled={immutable || busy === "timeline"} onClick={() => runAction("timeline")} style={btn(false)}>
            {busy === "timeline" ? "Working…" : "Generate Timeline"}
          </button>
          <button disabled={immutable || busy === "filings"} onClick={() => runAction("filings")} style={btn(false)}>
            {busy === "filings" ? "Working…" : "Generate Filings"}
          </button>
          <button disabled={immutable || busy === "export"} onClick={() => runAction("export")} style={btn(true)}>
            {busy === "export" ? "Working…" : "Export Packet"}
          </button>
          <a style={{ ...btn(false), textDecoration: "none", display: "inline-flex", alignItems: "center" }} href={`/admin/incidents/${encodeURIComponent(incidentId)}/bundle?orgId=${encodeURIComponent(orgId)}`}>
            Open Artifact →
          </a>
        </div>

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          Tip: Run Timeline → Filings → Export. Then verify ZIP and finalize on the Artifact page.
        </div>
      </div>
'''

# Inject helpers if missing
if "function runAction" not in s:
    # find a good insertion point: after state declarations or before return (
    m = re.search(r"(const\s+\[.*?\]\s*=\s*useState.*?\;\s*)\n\s*return\s*\(", s, re.S)
    if not m:
        # fallback: before "return ("
        m = re.search(r"\n\s*return\s*\(", s)
    if not m:
        raise SystemExit("❌ Could not find insertion point for helper functions in incident page.")

    helper = r'''
  const [busy, setBusy] = React.useState<string>("");

  async function runAction(kind: "timeline" | "filings" | "export") {
    if (busy) return;
    try {
      setBusy(kind);
      const base = kind === "timeline"
        ? `/api/fn/generateTimelineV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`
        : kind === "filings"
        ? `/api/fn/generateFilingsV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`
        : `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`;

      const method = kind === "export" ? "GET" : "POST";
      const r = await fetch(base, { method });
      const t = await r.text();
      let j: any = null;
      try { j = JSON.parse(t); } catch {}
      if (!r.ok || (j && j.ok === false)) {
        const msg = j?.error || t || `HTTP ${r.status}`;
        alert(`${kind.toUpperCase()} failed: ${msg}`);
        return;
      }
    } finally {
      setBusy("");
    }
  }
'''
    s = s[:m.start()] + helper + "\n" + s[m.start():]

# Inject UI block into render
# Insert after the header area if possible
m2 = re.search(r"(<div[^>]*>\s*<div[^>]*>\s*Guided Workflow)", s)
if m2:
    # insert right before "Guided Workflow" header (inside main container)
    s = s[:m2.start()] + block + "\n" + s[m2.start():]
else:
    # fallback: insert before first big section marker or before closing main wrapper
    m3 = re.search(r"\n\s*<div[^>]*>\s*<div[^>]*>\s*Timeline Preview", s)
    if m3:
        s = s[:m3.start()] + block + "\n" + s[m3.start():]
    else:
        # last resort: before end of return
        s = s.replace("</div>\n  );", block + "\n</div>\n  );")

p.write_text(s)
print("✅ patched incident page: Field Actions panel added")
PY

echo "🧹 restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ Open incident page:"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" 2>/dev/null || true
