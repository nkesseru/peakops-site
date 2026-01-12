#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak
cp "$FILE" "scripts/dev/_bak/bundle_page_${TS}.tsx"
echo "✅ backup: scripts/dev/_bak/bundle_page_${TS}.tsx"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# Ensure "use client"
if '"use client"' not in s.splitlines()[0:3]:
    s = '"use client";\n\n' + s

# Ensure React hooks import
if "useState" not in s or "useEffect" not in s:
    # replace basic React import with hooks
    s = re.sub(r'import\s+React\s*(?:,\s*\{[^}]*\})?\s+from\s+"react";',
               'import React, { useEffect, useMemo, useState } from "react";',
               s)
    # if there was no React import at all, add one
    if 'from "react"' not in s:
        s = 'import React, { useEffect, useMemo, useState } from "react";\n' + s

# Add button style helpers if missing
if "function btn(" not in s:
    insert_after = re.search(r'function\s+card\(\)\s*:\s*React\.CSSProperties\s*\{', s)
    if insert_after:
        # insert BEFORE card()
        idx = insert_after.start()
        btn_fn = '''
function btn(active: boolean = false): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: active ? "color-mix(in oklab, lime 18%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    fontWeight: 900,
    textDecoration: "none",
    display: "inline-block",
    cursor: "pointer",
    color: "CanvasText",
    userSelect: "none",
  };
}

'''
        s = s[:idx] + btn_fn + s[idx:]

# Ensure we have orgId/incidentId vars (most pages already do)
# We'll inject generate() + loadPacketMeta() in a safe spot: after const orgId/incidentId block.

# Find a spot after orgId/incidentId declarations
anchor = re.search(r'const\s+orgId\s*=.*?\n.*?const\s+incidentId\s*=.*?\n', s, flags=re.S)
if not anchor:
    # fallback: after useSearchParams/useParams area
    anchor = re.search(r'const\s+sp\s*=\s*useSearchParams\(\)\s*;.*?\n', s, flags=re.S)
if not anchor:
    raise SystemExit("❌ Could not find where to inject logic (orgId/incidentId/useSearchParams).")

inject_pos = anchor.end()

# Add state + loaders if not present
if "const [packetMeta" not in s:
    state_block = '''
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [packetMeta, setPacketMeta] = useState<any>(null);

  async function loadPacketMeta() {
    try {
      const url =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}` +
        `&dryRun=1`;
      const r = await fetch(url, { method: "GET" });
      const t = await r.text();
      const j = JSON.parse(t);
      if (j?.ok === false) throw new Error(String(j?.error || "exportIncidentPacketV1 dryRun failed"));
      setPacketMeta(j?.packetMeta || null);
    } catch (e: any) {
      // don't crash the page if meta can't load
      setPacketMeta(null);
    }
  }

  async function generatePacket() {
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(url, { method: "GET" });
      const t = await r.text();
      const j = JSON.parse(t);
      if (j?.ok === false) throw new Error(String(j?.error || "exportIncidentPacketV1 failed"));
      setPacketMeta(j?.packetMeta || null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadPacketMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

'''
    s = s[:inject_pos] + state_block + s[inject_pos:]

# Add button + wire into UI:
# We’ll locate the Packet Meta section and insert a Generate button next to Download.

# Replace "Download Packet (ZIP)" anchor to include a Generate button above it if not present
if "Generate Packet" not in s:
    s = s.replace(
        '<a',
        '<div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>\n'
        '  <button onClick={generatePacket} disabled={busy} style={btn(true)}>\n'
        '    {busy ? "Generating…" : "Generate Packet"}\n'
        "  </button>\n"
        '  <a',
        1
    )
    # close the wrapper after the first </a>
    s = s.replace("</a>", "</a>\n</div>", 1)

# Add packet meta render if not present (optional nice touch)
if "packetHash:" not in s and "packetMeta" in s:
    # try to insert into Packet Meta card content: after "<h3>Packet Meta</h3>"
    s = re.sub(
        r'(<h3>Packet Meta</h3>\s*)',
        r'\1<div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>\n'
        r'  packetHash: <span style={{ fontFamily: "ui-monospace" }}>{packetMeta?.packetHash || "—"}</span><br />\n'
        r'  sizeBytes: <span style={{ fontFamily: "ui-monospace" }}>{packetMeta?.sizeBytes ?? "—"}</span><br />\n'
        r'  generatedAt: <span style={{ fontFamily: "ui-monospace" }}>{packetMeta?.generatedAt || "—"}</span>\n'
        r'</div>\n',
        s,
        count=1
    )

# Add error render if missing
if "{err" not in s:
    # after top heading, insert error line
    s = re.sub(
        r'(<h1[^>]*>.*?</h1>\s*)',
        r'\1{err ? (\n'
        r'  <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>{err}</div>\n'
        r') : null}\n',
        s,
        count=1
    )

p.write_text(s)
print("✅ patched bundle page: added Generate Packet button + packet meta refresh")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke bundle page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" >/dev/null \
  && echo "✅ bundle page ok" \
  || (echo "❌ bundle page failing"; tail -n 160 .logs/next.log; exit 1)

echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
