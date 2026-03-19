#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

echo "==> (0) Env"
set -a
source ./.env.dev.local 2>/dev/null || true
set +a
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"
echo "FN_BASE=$FN_BASE"
echo "ORG_ID=$ORG_ID"
echo

echo "==> (1) Restore functions_clean/index.mjs to a clean baseline (tag preferred)"
FILE="functions_clean/index.mjs"
cp "$FILE" "$FILE.bak_$(date +%Y%m%d_%H%M%S)" || true

# Prefer known-good tag if it exists
if git rev-parse -q --verify "refs/tags/phase2-submitqueue-stable" >/dev/null 2>&1; then
  git checkout phase2-submitqueue-stable -- "$FILE" || true
else
  # fallback: restore from HEAD
  git checkout -- "$FILE" || true
fi

echo "==> (2) Patch index.mjs: imports + exports (safe placement; ensures hello closes)"
python3 - <<'PY'
from pathlib import Path

p = Path("functions_clean/index.mjs")
s = p.read_text()
hello_anchor = "export const hello = onRequest"
i = s.find(hello_anchor)
if i == -1:
    raise SystemExit("❌ Could not find hello export in functions_clean/index.mjs")

# Find end of hello handler by locating first occurrence of '});' after hello anchor
end = s.find("});", i)
if end == -1:
    # attempt to close right after first res.json inside hello
    j = s.find("res.json", i)
    if j == -1:
        raise SystemExit("❌ hello handler has no res.json and no closing '});' found")
    line_end = s.find("\n", j)
    if line_end == -1:
        line_end = j
    s = s[:line_end+1] + "});\n" + s[line_end+1:]
else:
    end = end + len("});")
imports_needed = [
  'import { handleGetContractsV1 } from "./getContractsV1.mjs";\n',
  'import { handleGetContractV1 } from "./getContractV1.mjs";\n',
]
onreq_line = 'import { onRequest } from "firebase-functions/v2/https";\n'
if onreq_line in s:
    ins_at = s.find(onreq_line) + len(onreq_line)
    block = ""
    for imp in imports_needed:
        if imp.strip() not in s:
            block += imp
    if block:
        s = s[:ins_at] + block + s[ins_at:]
else:
    # fallback: prepend imports
    block = "".join([imp for imp in imports_needed if imp.strip() not in s])
    s = block + s

bad_lines = [
    "export const getContractV1 = onRequest(getContractV1Handler);",
    "export const getContractV1 = onRequest(getContractV1);",
    "export const getContractsV1 = onRequest(getContractsV1);",
    "export const getContractsV1 = onRequest(handleGetContractsV1);",
    "export const getContractV1  = onRequest(handleGetContractV1);",
    "export const getContractV1 = onRequest(handleGetContractV1);",
]
for bl in bad_lines:
    s = s.replace(bl + "\n", "")
    s = s.replace("\n" + bl, "\n")
i = s.find(hello_anchor)
end = s.find("});", i)
if end == -1:
    raise SystemExit("❌ Could not find end of hello handler after patch")
end = end + len("});")

exports_block = "\nexport const getContractsV1 = onRequest(handleGetContractsV1);\nexport const getContractV1  = onRequest(handleGetContractV1);\n"
# (keep the spacing exactly as above; we intentionally align handler name)
if "export const getContractsV1" not in s:
    s = s[:end] + exports_block + s[end:]

Path("functions_clean/index.mjs").write_text(s)
print("✅ patched functions_clean/index.mjs")
PY

echo "==> (3) ESM import sanity (must pass)"
node -e "import('./functions_clean/index.mjs').then(()=>console.log('✅ ESM import OK')).catch(e=>{console.error('❌ ESM import failed'); console.error(e); process.exit(1);})"
echo

echo "==> (4) Deploy: getContractsV1 + getContractV1"
firebase deploy --only functions:getContractsV1,functions:getContractV1
echo "✅ deployed getContractsV1 + getContractV1"
echo

echo "==> (5) Create Next API routes: getContractsV1 + getContractV1 (+ writeContractPayloadV1 passthrough)"
mkdir -p next-app/src/app/api/fn/getContractsV1
mkdir -p next-app/src/app/api/fn/getContractV1
mkdir -p next-app/src/app/api/fn/writeContractPayloadV1

cat > next-app/src/app/api/fn/getContractsV1/route.ts <<'TS'
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const qs = u.searchParams.toString();
  const base = process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";
  const r = await fetch(`${base}/getContractsV1?${qs}`);
  const txt = await r.text();
  return new NextResponse(txt, { status: r.status, headers: { "Content-Type": "application/json" } });
}
TS

cat > next-app/src/app/api/fn/getContractV1/route.ts <<'TS'
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const qs = u.searchParams.toString();
  const base = process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";
  const r = await fetch(`${base}/getContractV1?${qs}`);
  const txt = await r.text();
  return new NextResponse(txt, { status: r.status, headers: { "Content-Type": "application/json" } });
}
TS

cat > next-app/src/app/api/fn/writeContractPayloadV1/route.ts <<'TS'
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const base = process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";
  const body = await req.text();
  const r = await fetch(`${base}/writeContractPayloadV1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const txt = await r.text();
  return new NextResponse(txt, { status: r.status, headers: { "Content-Type": "application/json" } });
}
TS

echo "✅ next-app api routes created: /api/fn/getContractsV1, /api/fn/getContractV1, /api/fn/writeContractPayloadV1"
echo

echo "==> (6) Admin Contracts list page"
mkdir -p next-app/src/app/admin/contracts
cat > next-app/src/app/admin/contracts/page.tsx <<'TSX'
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function AdminContracts() {
  const sp = useSearchParams();
  const orgId = sp.get("orgId") || "org_001";

  const [docs, setDocs] = useState<any[]>([]);
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getContractsV1?orgId=${encodeURIComponent(orgId)}&limit=50`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractsV1 failed");
      setDocs(Array.isArray(j.docs) ? j.docs : []);
    } catch (e:any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"baseline" }}>
        <h1 style={{ margin:0, fontSize: 22, fontWeight: 900 }}>Admin · Contracts</h1>
        <div style={{ opacity:0.7, fontSize:12 }}>Org: {orgId}</div>
      </div>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop: 14, alignItems:"center" }}>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding:"8px 12px",
            borderRadius:12,
            border:"1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background:"color-mix(in oklab, CanvasText 6%, transparent)",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>

        {!err && <div style={{ opacity:0.75 }}>Contracts: <b>{docs.length}</b></div>}
        {err && <div style={{ color:"crimson", fontWeight:800 }}>{err}</div>}
      </div>

      <div style={{ marginTop: 16, display:"grid", gap:10 }}>
        {docs.map((d:any) => (
          <a
            key={d.id}
            href={`/admin/contracts/${encodeURIComponent(d.id)}?orgId=${encodeURIComponent(orgId)}`}
            style={{
              textDecoration:"none",
              color:"CanvasText",
              border:"1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              borderRadius:14,
              padding:12,
              background:"color-mix(in oklab, CanvasText 3%, transparent)",
              display:"block",
            }}
          >
            <div style={{ fontWeight:900 }}>{d.id}</div>
            <div style={{ opacity:0.8, fontSize:13, marginTop:6 }}>
              {d.contractNumber ? `# ${d.contractNumber}` : ""} {d.type ? `· ${d.type}` : ""} {d.status ? `· ${d.status}` : ""}
            </div>
          </a>
        ))}
        {docs.length === 0 && !err && <div style={{ opacity:0.7 }}>No contracts found.</div>}
      </div>
    </div>
  );
}
TSX

echo "✅ created: /admin/contracts"
echo

echo "==> (7) Admin Contract payloads list + payload editor UI"
mkdir -p next-app/src/app/admin/contracts/[id]/payloads
mkdir -p next-app/src/app/admin/contracts/[id]/payloads/[payloadId]

cat > next-app/src/app/admin/contracts/[id]/payloads/page.tsx <<'TSX'
"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function mono(s: string) { return <span style={{ fontFamily:"ui-monospace, Menlo, monospace" }}>{s}</span>; }

export default function ContractPayloadsList() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const orgId = sp.get("orgId") || "org_001";

  const [docs, setDocs] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=50`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");
      setDocs(Array.isArray(j.docs) ? j.docs : []);
    } catch (e:any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (contractId) load(); }, [contractId]); // eslint-disable-line

  return (
    <div style={{ padding:24, fontFamily:"system-ui", color:"CanvasText" }}>
      <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"baseline" }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:900 }}>Contract {contractId} · Payloads</h1>
        <a href={`/admin/contracts/${encodeURIComponent(contractId)}?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration:"none", opacity:0.8, color:"CanvasText" }}>← Back</a>
      </div>
      <div style={{ marginTop:6, fontSize:12, opacity:0.7 }}>Org: {orgId}</div>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:14, alignItems:"center" }}>
        <button onClick={load} disabled={busy} style={{ padding:"8px 12px", borderRadius:12, border:"1px solid color-mix(in oklab, CanvasText 20%, transparent)", background:"color-mix(in oklab, CanvasText 6%, transparent)" }}>
          {busy ? "Loading…" : "Refresh"}
        </button>
        {!err && <div style={{ opacity:0.75 }}>Payloads: <b>{docs.length}</b></div>}
        {err && <div style={{ color:"crimson", fontWeight:800 }}>{err}</div>}
      </div>

      <div style={{ marginTop:16, display:"grid", gap:10 }}>
        {docs.map((d:any) => (
          <a
            key={d.id}
            href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads/${encodeURIComponent(d.id)}?orgId=${encodeURIComponent(orgId)}`}
            style={{ textDecoration:"none", color:"CanvasText", border:"1px solid color-mix(in oklab, CanvasText 14%, transparent)", borderRadius:14, padding:12, background:"color-mix(in oklab, CanvasText 3%, transparent)", display:"block" }}
          >
            <div style={{ display:"flex", gap:12, flexWrap:"wrap", alignItems:"baseline" }}>
              <div style={{ fontWeight:900 }}>{d.type || d.id}</div>
              <div style={{ opacity:0.7 }}>doc:</div>
              <div>{mono(String(d.id || ""))}</div>
              <div style={{ opacity:0.7 }}>schema:</div>
              <div style={{ fontWeight:800 }}>{d.schemaVersion || "—"}</div>
            </div>
          </a>
        ))}
        {docs.length === 0 && !err && <div style={{ opacity:0.7 }}>No payloads found.</div>}
      </div>
    </div>
  );
}
TSX

cat > next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function safeJsonParse(s: string) {
  try { return { ok:true, value: JSON.parse(s) }; }
  catch (e:any) { return { ok:false, error: String(e?.message || e) }; }
}

export default function ContractPayloadEditor() {
  const params = useParams<{ id: string; payloadId: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const payloadId = params.payloadId;
  const orgId = sp.get("orgId") || "org_001";

  const [doc, setDoc] = useState<any>(null);
  const [jsonText, setJsonText] = useState<string>("{}");
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string>("");

  const parsed = useMemo(() => safeJsonParse(jsonText), [jsonText]);

  async function load() {
    setBusy(true); setErr(""); setBanner("");
    try {
      const r = await fetch(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");
      const found = (Array.isArray(j.docs) ? j.docs : []).find((x:any) => String(x.id) === String(payloadId));
      if (!found) throw new Error(`payloadId not found: ${payloadId}`);
      setDoc(found);
      setJsonText(JSON.stringify(found.payload || {}, null, 2));
    } catch (e:any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true); setErr(""); setBanner("");
    try {
      if (!parsed.ok) throw new Error(`Invalid JSON: ${parsed.error}`);
      const body = {
        orgId,
        contractId,
        type: doc?.type || null,
        versionId: doc?.versionId || "v1",
        schemaVersion: doc?.schemaVersion || null,
        payload: parsed.value,
        createdBy: "admin_ui",
      };
      const r = await fetch(`/api/fn/writeContractPayloadV1`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "writeContractPayloadV1 failed");
      setBanner("✅ Saved");
      await load();
    } catch (e:any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (contractId && payloadId) load(); }, [contractId, payloadId]); // eslint-disable-line

  return (
    <div style={{ padding:24, fontFamily:"system-ui", color:"CanvasText" }}>
      <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"baseline" }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:900 }}>Payload Editor · {payloadId}</h1>
        <a href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration:"none", opacity:0.8, color:"CanvasText" }}>← Back</a>
      </div>
      <div style={{ marginTop:6, fontSize:12, opacity:0.7 }}>Org: {orgId} · Contract: {contractId}</div>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop:14, alignItems:"center" }}>
        <button onClick={load} disabled={busy} style={{ padding:"8px 12px", borderRadius:12, border:"1px solid color-mix(in oklab, CanvasText 20%, transparent)", background:"color-mix(in oklab, CanvasText 6%, transparent)" }}>
          {busy ? "Loading…" : "Refresh"}
        </button>
        <button onClick={save} disabled={busy || !parsed.ok} style={{ padding:"8px 12px", borderRadius:12, border:"1px solid color-mix(in oklab, CanvasText 20%, transparent)", background:"color-mix(in oklab, CanvasText 10%, transparent)", fontWeight:900 }}>
          {busy ? "Saving…" : "Save"}
        </button>
        {banner && <div style={{ color:"#6bff9a", fontWeight:900 }}>{banner}</div>}
        {err && <div style={{ color:"crimson", fontWeight:900 }}>{err}</div>}
        {!err && !banner && !parsed.ok && <div style={{ color:"#ffb86b", fontWeight:900 }}>Invalid JSON</div>}
      </div>

      <div style={{ marginTop:16 }}>
        <div style={{ opacity:0.75, fontSize:13 }}>
          Tip: paste valid JSON only. Save writes via <b>writeContractPayloadV1</b>.
        </div>
        <textarea
          value={jsonText}
          onChange={(e)=>setJsonText(e.target.value)}
          spellCheck={false}
          style={{
            marginTop:10,
            width:"100%",
            minHeight:420,
            padding:12,
            borderRadius:14,
            border:"1px solid color-mix(in oklab, CanvasText 14%, transparent)",
            background:"color-mix(in oklab, CanvasText 2%, transparent)",
            color:"CanvasText",
            fontFamily:"ui-monospace, Menlo, monospace",
            fontSize:12,
            lineHeight:1.4,
          }}
        />
      </div>
    </div>
  );
}
TSX

echo "✅ created payload UI:"
echo "  /admin/contracts/[id]/payloads"
echo "  /admin/contracts/[id]/payloads/[payloadId]"
echo
echo "Try:"
echo "  http://localhost:3000/admin/contracts?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=$ORG_ID"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=$ORG_ID"
