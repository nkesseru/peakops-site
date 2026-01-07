#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

echo "==> (1) Patch next-app API: /api/contracts/list -> proxy functions:getContractsV1"
mkdir -p next-app/src/app/api/contracts/list
cat > next-app/src/app/api/contracts/list/route.ts <<'TS'
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const qs = url.searchParams.toString();
    const base =
      process.env.NEXT_PUBLIC_PEAKOPS_FN_BASE ||
      "http://127.0.0.1:5001/peakops-pilot/us-central1";

    const r = await fetch(`${base}/getContractsV1?${qs}`, { method: "GET" });

    const text = await r.text();
    let j: any = {};
    try { j = JSON.parse(text); } catch { j = { ok: false, error: text.slice(0, 500) }; }

    return NextResponse.json(j, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS
echo "✅ wrote next-app/src/app/api/contracts/list/route.ts"

echo
echo "==> (2) Patch admin contracts list page to use /api/contracts/list (already) + show errors cleanly"
mkdir -p next-app/src/app/admin/contracts
cat > next-app/src/app/admin/contracts/page.tsx <<'TSX'
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

export default function AdminContracts() {
  const sp = useSearchParams();
  const orgId = sp.get("orgId") || "org_001";

  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/contracts/list?orgId=${encodeURIComponent(orgId)}&limit=50`);
      const text = await r.text();
      let j: any = {};
      try { j = JSON.parse(text); } catch { j = { ok: false, error: text.slice(0, 500) }; }

      if (!j?.ok) throw new Error(j?.error || "getContractsV1 failed");
      setRows(Array.isArray(j.docs) ? j.docs : []);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setRows([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, [orgId]); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>Admin · Contracts</h1>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Org: {orgId}</div>
      </div>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop: 14, alignItems:"center" }}>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding:"8px 12px",
            borderRadius: 12,
            border:"1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background:"color-mix(in oklab, CanvasText 6%, transparent)",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>

        {!err && <div style={{ opacity: 0.75 }}>Contracts: <b>{rows.length}</b></div>}
        {err && <div style={{ color: "crimson", fontWeight: 900 }}>{err}</div>}
      </div>

      <div style={{ marginTop: 16 }}>
        {rows.length === 0 && !err && <div style={{ opacity: 0.7 }}>No contracts found.</div>}

        {rows.length > 0 && (
          <div style={{ border:"1px solid color-mix(in oklab, CanvasText 14%, transparent)", borderRadius:14, overflow:"hidden" }}>
            <div style={{ display:"grid", gridTemplateColumns:"220px 160px 120px 120px 1fr", padding:10, fontSize:12, opacity:0.8, borderBottom:"1px solid color-mix(in oklab, CanvasText 12%, transparent)" }}>
              <div>ID</div><div>Contract #</div><div>Type</div><div>Status</div><div>Customer</div>
            </div>

            {rows.map((c:any) => (
              <a
                key={c.id}
                href={`/admin/contracts/${encodeURIComponent(c.id)}?orgId=${encodeURIComponent(orgId)}`}
                style={{
                  textDecoration:"none",
                  color:"CanvasText",
                  display:"grid",
                  gridTemplateColumns:"220px 160px 120px 120px 1fr",
                  padding:12,
                  borderBottom:"1px solid color-mix(in oklab, CanvasText 10%, transparent)",
                  background:"color-mix(in oklab, CanvasText 2%, transparent)",
                }}
              >
                <div>{mono(String(c.id))}</div>
                <div style={{ fontWeight: 800 }}>{c.contractNumber || "—"}</div>
                <div>{c.type || "—"}</div>
                <div>{c.status || "—"}</div>
                <div>{c.customerId ? mono(String(c.customerId)) : "—"}</div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
TSX
echo "✅ wrote next-app/src/app/admin/contracts/page.tsx"

echo
echo "==> (3) Patch contract detail page to show the REAL error from /api/fn/getContractPayloadsV1"
FILE="next-app/src/app/admin/contracts/[id]/page.tsx"
if [ -f "$FILE" ]; then
  python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/admin/contracts/[id]/page.tsx")
s = p.read_text()

# Make load() read text + parse JSON safely so errors show
s = s.replace(
  "const j = await r.json();",
  "const text = await r.text();\n      let j: any = {};\n      try { j = JSON.parse(text); } catch { j = { ok: false, error: text.slice(0, 500) }; }"
)

# Make the throw show j.error if present
s = s.replace(
  'if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");',
  'if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");'
)

p.write_text(s)
print("✅ patched contract detail page error surfacing")
PY
else
  echo "⚠️ missing $FILE (skipping)"
fi

echo
echo "==> (4) Restart Next on 3000"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
pnpm -C next-app dev --port 3000
