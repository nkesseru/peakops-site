#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

# -------------------------
# 1) Ensure Next proxy helper exists (App Router)
# -------------------------
mkdir -p next-app/src/app/api/fn/_lib

cat > next-app/src/app/api/fn/_lib/fnProxy.ts <<'TS'
/**
 * Next API -> Firebase/CloudRun function proxy
 * Requires NEXT runtime "nodejs"
 */
function baseFromEnv() {
  // Use FN_BASE from next-app/.env.local (or process env)
  const base = process.env.FN_BASE || "";
  if (!base) throw new Error("FN_BASE is not set in next-app/.env.local");
  return base.replace(/\/+$/, "");
}

function withQuery(target: URL, src: URL) {
  // forward all query params
  src.searchParams.forEach((v, k) => target.searchParams.set(k, v));
  return target;
}

export async function proxyGET(req: Request, fnName: string) {
  const src = new URL(req.url);
  const target = withQuery(new URL(`${baseFromEnv()}/${fnName}`), src);

  const r = await fetch(target.toString(), { method: "GET" });
  const text = await r.text();

  // If it's JSON, return JSON, else return raw text
  try {
    const j = JSON.parse(text);
    return new Response(JSON.stringify(j), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(text, { status: r.status, headers: { "Content-Type": "text/plain" } });
  }
}

export async function proxyPOST(req: Request, fnName: string) {
  const src = new URL(req.url);
  const target = withQuery(new URL(`${baseFromEnv()}/${fnName}`), src);

  const body = await req.text();
  const r = await fetch(target.toString(), {
    method: "POST",
    headers: { "Content-Type": req.headers.get("content-type") || "application/json" },
    body,
  });

  const text = await r.text();
  try {
    const j = JSON.parse(text);
    return new Response(JSON.stringify(j), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(text, { status: r.status, headers: { "Content-Type": "text/plain" } });
  }
}
TS

# -------------------------
# 2) Add packet endpoints:
#    - /api/contracts/[contractId]/packet.preview  (JSON)
#    - /api/contracts/[contractId]/packet.zip      (binary zip download)
# -------------------------
mkdir -p next-app/src/app/api/contracts/[contractId]/packet.preview
mkdir -p next-app/src/app/api/contracts/[contractId]/packet.zip

cat > next-app/src/app/api/contracts/[contractId]/packet.preview/route.ts <<'TS'
import { proxyGET } from "../../../fn/_lib/fnProxy";

export const runtime = "nodejs";

export async function GET(req: Request) {
  // proxy to exportContractPacketV1 (returns JSON with zipBase64)
  // then strip the base64 to keep preview light
  const r = await proxyGET(req, "exportContractPacketV1");
  const j = await r.json().catch(() => null);

  if (!j?.ok) return new Response(JSON.stringify(j || { ok:false, error:"preview failed" }), { status: 400, headers:{ "Content-Type":"application/json" } });

  const { zipBase64, ...rest } = j;
  return new Response(JSON.stringify({ ok:true, preview: rest }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
TS

cat > next-app/src/app/api/contracts/[contractId]/packet.zip/route.ts <<'TS'
import { proxyGET } from "../../../fn/_lib/fnProxy";

export const runtime = "nodejs";

function b64ToUint8(b64: string) {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf);
}

export async function GET(req: Request) {
  const r = await proxyGET(req, "exportContractPacketV1");
  const j = await r.json().catch(() => null);

  if (!j?.ok) {
    return new Response(JSON.stringify(j || { ok:false, error:"exportContractPacketV1 failed" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const bytes = b64ToUint8(j.zipBase64 || "");
  const filename = (j.filename || "contract_packet.zip").replace(/[^a-zA-Z0-9._-]/g, "_");

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
TS

# -------------------------
# 3) Add a tiny Admin nav component (used across pages)
# -------------------------
mkdir -p next-app/src/app/admin/_components

cat > next-app/src/app/admin/_components/AdminNav.tsx <<'TSX'
"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

function pillStyle(active=false) {
  return {
    padding: "8px 12px",
    borderRadius: 14,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "color-mix(in oklab, CanvasText 4%, transparent)",
    textDecoration: "none",
    color: "CanvasText",
    fontWeight: 900 as const,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  };
}

export default function AdminNav({ active }: { active?: "contracts" | "incidents" }) {
  const sp = useSearchParams();
  const orgId = sp.get("orgId") || "org_001";

  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      <Link href={`/admin/contracts?orgId=${encodeURIComponent(orgId)}`} style={pillStyle(active==="contracts")}>Contracts</Link>
      <Link href={`/admin/incidents?orgId=${encodeURIComponent(orgId)}`} style={pillStyle(active==="incidents")}>Incidents</Link>
      <div style={{ marginLeft: "auto", opacity: 0.7, fontSize: 12 }}>Org: {orgId}</div>
    </div>
  );
}
TSX

# -------------------------
# 4) Patch Contract Detail page to add:
#    - top nav
#    - Preview button (opens /api/contracts/.../packet.preview)
#    - Download ZIP button (hits /api/contracts/.../packet.zip)
# -------------------------
python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/admin/contracts/[id]/page.tsx")
if not p.exists():
  raise SystemExit("❌ missing: next-app/src/app/admin/contracts/[id]/page.tsx")

s = p.read_text()

# add import if missing
if "AdminNav" not in s:
  s = s.replace('"use client";', '"use client";\n\nimport AdminNav from "../_components/AdminNav";')

# add preview state + handler if missing
if "packetPreview" not in s:
  inject = """
  const [packetPreview, setPacketPreview] = useState<any>(null);
  const [pktBusy, setPktBusy] = useState(false);

  async function loadPacketPreview() {
    setPktBusy(true);
    try {
      const r = await fetch(`/api/contracts/${encodeURIComponent(contractId)}/packet.preview?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&versionId=v1&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "preview failed");
      setPacketPreview(j.preview || null);
    } finally {
      setPktBusy(false);
    }
  }
"""
  # place after existing state declarations: find first occurrence of "useState" block end by searching "const [docs"
  # safer: inject before the load() function definition
  marker = "async function load()"
  if marker in s:
    s = s.replace(marker, inject + "\n" + marker)
  else:
    # fallback: append near top of component
    pass

# insert AdminNav + buttons near top inside return
if "<AdminNav" not in s:
  # Find first <div style={{ padding: 24 ... }}> line and inject nav right after it
  needle = "<div style={{ padding: 24"
  idx = s.find(needle)
  if idx == -1:
    raise SystemExit("❌ could not find outer wrapper div to insert AdminNav")
  # insert right after the opening wrapper line (end of that line)
  line_end = s.find("\n", idx)
  s = s[:line_end+1] + '      <div style={{ marginBottom: 14 }}><AdminNav active="contracts" /></div>\n' + s[line_end+1:]

# Add Preview + Download buttons in the existing button row:
# We look for the existing "Refresh" button block, then add two buttons after it.
if "Download Contract Packet ZIP" not in s:
  # find the Refresh button closing tag and inject after it
  marker = '{busy ? "Loading…" : "Refresh"}'
  mi = s.find(marker)
  if mi == -1:
    raise SystemExit("❌ could not find Refresh button to anchor")
  # find the button close "        </button>" after marker
  end_btn = s.find("</button>", mi)
  end_btn = s.find("\n", end_btn)  # end line after </button>
  insert = """
        <button
          onClick={loadPacketPreview}
          disabled={pktBusy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            cursor: pktBusy ? "not-allowed" : "pointer",
          }}
        >
          {pktBusy ? "Previewing…" : "Packet Preview"}
        </button>

        <a
          href={`/api/contracts/${encodeURIComponent(contractId)}/packet.zip?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&versionId=v1&limit=200`}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            textDecoration: "none",
            color: "CanvasText",
            fontWeight: 900,
          }}
        >
          Download Contract Packet ZIP
        </a>
"""
  s = s[:end_btn+1] + insert + s[end_btn+1:]

# Add preview panel section if missing
if "Packet Preview" in s and "packetPreview" in s and "preview:" not in s:
  # place a new card after the Overview pre or after the main header
  anchor = '<div style={{ marginTop: 16, display: "grid", gap: 10 }}>'
  if anchor in s and "packetPreview" in s:
    add = """
      <div
        style={{
          border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
          borderRadius: 14,
          padding: 12,
          background: "color-mix(in oklab, CanvasText 3%, transparent)",
        }}
      >
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Packet Preview</div>
        {!packetPreview && <div style={{ opacity: 0.7 }}>Click “Packet Preview”.</div>}
        {packetPreview && (
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
{JSON.stringify(packetPreview, null, 2)}
          </pre>
        )}
      </div>
"""
    s = s.replace(anchor, anchor + "\n" + add)

p.write_text(s)
print("✅ patched: contract detail nav + packet preview + zip download")
PY

# -------------------------
# 5) Restart Next
# -------------------------
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "✅ Next restarted"
echo "Open:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
