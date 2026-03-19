#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app
FILE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

mkdir -p scripts/dev/_bak .logs
cp "$FILE" "scripts/dev/_bak/bundle_page_${TS}.tsx"
echo "✅ backup: scripts/dev/_bak/bundle_page_${TS}.tsx"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 1) Fix the broken state line where JSX got injected into useState<>
#    Replace anything like:
#      const [packetMeta, setPacketMeta] = useState<div style=...>
#    with a sane state:
s2 = re.sub(
    r'const\s+\[packetMeta,\s*setPacketMeta\]\s*=\s*useState<[^;]*;\s*',
    'const [packetMeta, setPacketMeta] = useState<any>(null);\n',
    s,
    flags=re.M
)
# If the above pattern didn't match (different corruption), do a more aggressive fix:
if s2 == s:
    s2 = re.sub(
        r'const\s+\[packetMeta,\s*setPacketMeta\]\s*=\s*useState.*\n',
        'const [packetMeta, setPacketMeta] = useState<any>(null);\n',
        s,
        flags=re.M
    )
s = s2

# 2) Ensure React imports include hooks we use
# If file has: import React from "react";
# replace with hooks import
s = re.sub(
    r'^\s*import\s+React\s+from\s+"react";\s*$',
    'import React, { useEffect, useMemo, useState } from "react";',
    s,
    flags=re.M
)

# If file already has React import but missing some hooks, don't overcomplicate; assume it's okay.

# 3) Ensure generatePacket() exists
if "async function generatePacket" not in s:
    insert_fn = r'''
  async function generatePacket() {
    setBusy(true);
    setErr("");
    try {
      const api =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(api, { method: "GET" });
      const text = await r.text();

      let j: any;
      try {
        j = JSON.parse(text || "{}");
      } catch {
        throw new Error(`exportIncidentPacketV1 returned non-JSON (HTTP ${r.status})`);
      }

      if (j?.ok === false) throw new Error(String(j?.error || "exportIncidentPacketV1 failed"));

      if (j?.packetMeta) setPacketMeta(j.packetMeta);
      // Optionally refresh any other view state here later
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
'''.strip("\n")

    # Place it after load() if present, otherwise after state declarations
    m = re.search(r'async\s+function\s+load\s*\(\)\s*\{[\s\S]*?\n\s*\}\n', s)
    if m:
        s = s[:m.end()] + "\n\n" + insert_fn + "\n" + s[m.end():]
    else:
        # after packetMeta state line
        m2 = re.search(r'const\s+\[packetMeta,\s*setPacketMeta\][^\n]*\n', s)
        if m2:
            s = s[:m2.end()] + "\n" + insert_fn + "\n" + s[m2.end():]
        else:
            # last resort: append near top
            s = insert_fn + "\n\n" + s

# 4) Insert the Generate button in JSX above the Download button/link
# We will insert only once.
if "Generate Packet" not in s:
    btn_block = r'''
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <button onClick={generatePacket} disabled={busy} style={btn(true)}>
            {busy ? "Generating…" : "Generate Packet"}
          </button>
        </div>
'''.strip("\n")

    # Find first occurrence of Download Packet label in JSX
    m3 = re.search(r'(\s*<[^>]*>\s*Download Packet \(ZIP\)\s*</[^>]*>\s*)', s)
    if m3:
        s = s[:m3.start()] + btn_block + "\n" + s[m3.start():]
    else:
        # fallback: find "Packet Meta" section header and inject after it
        m4 = re.search(r'(Packet Meta[\s\S]{0,200}?\n)', s)
        if m4:
            s = s[:m4.end()] + btn_block + "\n" + s[m4.end():]

# 5) Add error render if missing (optional, safe)
if "{err" not in s:
    s = re.sub(
        r'(<h1[^>]*>.*?</h1>\s*)',
        r'\1{err ? (\n  <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>{err}</div>\n) : null}\n',
        s,
        count=1
    )

p.write_text(s)
print("✅ fixed bundle page parse + added Generate Packet button safely")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke bundle page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
curl -fsS "$URL" >/dev/null \
  && echo "✅ bundle page OK" \
  || (echo "❌ bundle page still failing"; tail -n 180 .logs/next.log; exit 1)

echo "OPEN:"
echo "  $URL"
