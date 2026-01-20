#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

echo "==> (0) Ensure scripts folder"
mkdir -p scripts/dev

echo "==> (1) Create Next API proxy routes (contracts + payloads)"
mkdir -p next-app/src/app/api/fn

# --- helper: create a proxy route file ---
write_proxy () {
  local name="$1"   # e.g. getContractsV1
  local method="$2" # GET or POST
  local target="$3" # e.g. /getContractsV1 or /writeContractPayloadV1

  mkdir -p "next-app/src/app/api/fn/${name}"
  cat > "next-app/src/app/api/fn/${name}/route.ts" <<TS
import { NextRequest, NextResponse } from "next/server";

const FN_BASE = process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";

export async function ${method}(req: NextRequest) {
  const url = new URL(req.url);
  const qs = url.searchParams.toString();
  const target = \`\${FN_BASE}${target}\${qs ? "?" + qs : ""}\`;

  try {
    const init: RequestInit = { method: "${method}" };
    if ("${method}" === "POST") {
      const body = await req.text();
      init.headers = { "Content-Type": "application/json" };
      init.body = body;
    }
    const r = await fetch(target, init);
    const txt = await r.text();
    return new NextResponse(txt, {
      status: r.status,
      headers: { "Content-Type": r.headers.get("content-type") || "application/json" },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS
  echo "✅ api: /api/fn/${name}"
}

# GET proxies
write_proxy "getContractsV1" "GET" "/getContractsV1"
write_proxy "getContractV1" "GET" "/getContractV1"
write_proxy "getContractPayloadsV1" "GET" "/getContractPayloadsV1"

# POST proxy
write_proxy "writeContractPayloadV1" "POST" "/writeContractPayloadV1"

echo "==> (2) Admin Contracts pages"
mkdir -p next-app/src/app/admin/contracts
mkdir -p next-app/src/app/admin/contracts/[id]
mkdir -p next-app/src/app/admin/contracts/[id]/payloads
mkdir -p next-app/src/app/admin/contracts/[id]/payloads/[payloadId]

# --- /admin/contracts (list) ---
cat > next-app/src/app/admin/contracts/page.tsx <<'TSX'
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function Btn(p: any) {
  return (
    <button
      {...p}
      style={{
        padding: "8px 12px",
        borderRadius: 12,
        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
        background: "color-mix(in oklab, CanvasText 6%, transparent)",
        cursor: p.disabled ? "not-allowed" : "pointer",
        ...(p.style || {}),
      }}
    />
  );
}

export default function AdminContractsList() {
  const sp = useSearchParams();
  const orgId = sp.get("orgId") || "org_001";

  const [docs, setDocs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getContractsV1?orgId=${encodeURIComponent(orgId)}&limit=50`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractsV1 failed");
      setDocs(Array.isArray(j.docs) ? j.docs : []);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setDocs([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:12 }}>
        <h1 style={{ margin:0, fontSize: 22, fontWeight: 900 }}>Admin · Contracts</h1>
        <div style={{ opacity: 0.7, fontSize: 12 }}>Org: {orgId}</div>
      </div>

      <div style={{ display:"flex", gap:10, alignItems:"center", marginTop: 14, flexWrap:"wrap" }}>
        <Btn onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</Btn>
        {!err && <div style={{ opacity: 0.75 }}>Contracts: <b>{docs.length}</b></div>}
        {err && <div style={{ color:"crimson", fontWeight: 900 }}>{err}</div>}
      </div>

      <div style={{ marginTop: 16, border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)", borderRadius: 14, overflow:"hidden" }}>
        <div style={{ display:"grid", gridTemplateColumns:"220px 160px 110px 120px 1fr", gap:0, padding:"10px 12px", fontSize: 12, opacity: 0.75, borderBottom:"1px solid color-mix(in oklab, CanvasText 10%, transparent)" }}>
          <div>ID</div><div>Contract #</div><div>Type</div><div>Status</div><div>Customer</div>
        </div>

        {docs.map((d:any) => (
          <a
            key={d.id}
            href={`/admin/contracts/${encodeURIComponent(d.id)}?orgId=${encodeURIComponent(orgId)}`}
            style={{ textDecoration:"none", color:"CanvasText" }}
          >
            <div style={{ display:"grid", gridTemplateColumns:"220px 160px 110px 120px 1fr", padding:"10px 12px", borderBottom:"1px solid color-mix(in oklab, CanvasText 8%, transparent)" }}>
              <div style={{ fontFamily:"ui-monospace, Menlo, monospace" }}>{d.id}</div>
              <div style={{ fontWeight: 800 }}>{d.contractNumber || "—"}</div>
              <div>{d.type || "—"}</div>
              <div>{d.status || "—"}</div>
              <div style={{ fontFamily:"ui-monospace, Menlo, monospace" }}>{d.customerId || "—"}</div>
            </div>
          </a>
        ))}

        {docs.length === 0 && !err && (
          <div style={{ padding:"12px", opacity:0.75 }}>No contracts found.</div>
        )}
      </div>
    </div>
  );
}
TSX
echo "✅ ui: /admin/contracts"

# --- /admin/contracts/[id] (detail + link to payloads) ---
cat > next-app/src/app/admin/contracts/[id]/page.tsx <<'TSX'
"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function Btn(p: any) {
  return (
    <button
      {...p}
      style={{
        padding: "8px 12px",
        borderRadius: 12,
        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
        background: "color-mix(in oklab, CanvasText 6%, transparent)",
        cursor: p.disabled ? "not-allowed" : "pointer",
        ...(p.style || {}),
      }}
    />
  );
}

export default function AdminContractDetail() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const orgId = sp.get("orgId") || "org_001";

  const [doc, setDoc] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractV1 failed");
      setDoc(j.doc || null);
    } catch (e:any) {
      setErr(String(e?.message || e));
      setDoc(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (contractId) load(); }, [contractId]); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"baseline" }}>
        <h1 style={{ margin:0, fontSize: 22, fontWeight: 900 }}>Admin · Contract {contractId}</h1>
        <a href={`/admin/contracts?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration:"none", opacity:0.8, color:"CanvasText" }}>← Back</a>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>Org: {orgId}</div>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop: 14, alignItems:"center" }}>
        <Btn onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</Btn>
        <a href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration:"none" }}>
          <Btn disabled={false}>Payloads →</Btn>
        </a>
        {err && <div style={{ color:"crimson", fontWeight: 900 }}>{err}</div>}
      </div>

      <div style={{ marginTop: 16, border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)", borderRadius: 14, padding: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Overview</div>
        <pre style={{ margin:0, whiteSpace:"pre-wrap", fontSize: 12, opacity: 0.9 }}>
{doc ? JSON.stringify(doc, null, 2) : "null"}
        </pre>
      </div>
    </div>
  );
}
TSX
echo "✅ ui: /admin/contracts/[id]"

# --- /admin/contracts/[id]/payloads (payloads list) ---
cat > next-app/src/app/admin/contracts/[id]/payloads/page.tsx <<'TSX'
"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function Btn(p: any) {
  return (
    <button
      {...p}
      style={{
        padding: "8px 12px",
        borderRadius: 12,
        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
        background: "color-mix(in oklab, CanvasText 6%, transparent)",
        cursor: p.disabled ? "not-allowed" : "pointer",
      }}
    />
  );
}

function fmtTs(x:any) {
  if (!x) return "—";
  if (typeof x === "object" && typeof x._seconds === "number") return new Date(x._seconds * 1000).toLocaleString();
  if (typeof x === "string") { try { return new Date(x).toLocaleString(); } catch { return x; } }
  return String(x);
}

export default function AdminContractPayloadsList() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const orgId = sp.get("orgId") || "org_001";

  const [docs, setDocs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=50`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");
      setDocs(Array.isArray(j.docs) ? j.docs : []);
    } catch (e:any) {
      setErr(String(e?.message || e));
      setDocs([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (contractId) load(); }, [contractId]); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:12 }}>
        <h1 style={{ margin:0, fontSize: 22, fontWeight: 900 }}>Admin · Payloads</h1>
        <a href={`/admin/contracts/${encodeURIComponent(contractId)}?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration:"none", opacity:0.8, color:"CanvasText" }}>← Back</a>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>Org: {orgId} · Contract: {contractId}</div>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop: 14, alignItems:"center" }}>
        <Btn onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</Btn>
        {!err && <div style={{ opacity: 0.75 }}>Count: <b>{docs.length}</b></div>}
        {err && <div style={{ color:"crimson", fontWeight: 900 }}>{err}</div>}
      </div>

      <div style={{ marginTop: 16, display:"grid", gap:10 }}>
        {docs.map((d:any) => (
          <a
            key={d.id}
            href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads/${encodeURIComponent(d.id)}?orgId=${encodeURIComponent(orgId)}`}
            style={{ textDecoration:"none", color:"CanvasText" }}
          >
            <div style={{
              border:"1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              borderRadius: 14,
              padding: 12,
              background:"color-mix(in oklab, CanvasText 3%, transparent)",
            }}>
              <div style={{ display:"flex", gap:12, flexWrap:"wrap", alignItems:"baseline" }}>
                <div style={{ fontWeight: 900 }}>{d.type || d.id}</div>
                <div style={{ opacity: 0.7 }}>doc:</div>
                <div style={{ fontFamily:"ui-monospace, Menlo, monospace" }}>{d.id}</div>
                <div style={{ opacity: 0.7 }}>schema:</div>
                <div style={{ fontWeight: 800 }}>{d.schemaVersion || "—"}</div>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                updatedAt: {fmtTs(d.updatedAt)} · payloadHash: <span style={{ fontFamily:"ui-monospace, Menlo, monospace" }}>{String(d.payloadHash || "—")}</span>
              </div>
            </div>
          </a>
        ))}
        {docs.length === 0 && !err && <div style={{ opacity: 0.7 }}>No payload docs yet.</div>}
      </div>
    </div>
  );
}
TSX
echo "✅ ui: /admin/contracts/[id]/payloads"

# --- /admin/contracts/[id]/payloads/[payloadId] (editor) ---
cat > next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function Btn(p: any) {
  return (
    <button
      {...p}
      style={{
        padding: "8px 12px",
        borderRadius: 12,
        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
        background: "color-mix(in oklab, CanvasText 6%, transparent)",
        cursor: p.disabled ? "not-allowed" : "pointer",
        ...(p.style || {}),
      }}
    />
  );
}

export default function AdminContractPayloadEditor() {
  const params = useParams<{ id: string; payloadId: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const payloadId = params.payloadId;
  const orgId = sp.get("orgId") || "org_001";

  const [doc, setDoc] = useState<any>(null);
  const [text, setText] = useState<string>("{}");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [banner, setBanner] = useState<string>("");

  const parsed = useMemo(() => {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e:any) {
      return { ok: false, error: String(e?.message || e) };
    }
  }, [text]);

  async function load() {
    setBusy(true);
    setErr("");
    setBanner("");
    try {
      const r = await fetch(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");
      const found = (j.docs || []).find((x:any) => x.id === payloadId);
      if (!found) throw new Error(`payload doc not found: ${payloadId}`);
      setDoc(found);
      setText(JSON.stringify(found.payload || {}, null, 2));
    } catch (e:any) {
      setErr(String(e?.message || e));
      setDoc(null);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBanner("");
    setErr("");
    if (!parsed.ok) { setErr(`Invalid JSON: ${parsed.error}`); return; }
    if (!doc) { setErr("No doc loaded"); return; }

    setBusy(true);
    try {
      const body = {
        orgId,
        contractId,
        type: doc.type,
        versionId: doc.versionId,
        schemaVersion: doc.schemaVersion,
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
      setBanner(`✅ Saved (${j.payloadDocId})`);
      await load();
    } catch (e:any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (contractId && payloadId) load(); }, [contractId, payloadId]); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:12 }}>
        <h1 style={{ margin:0, fontSize: 22, fontWeight: 900 }}>Admin · Payload Editor</h1>
        <a href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration:"none", opacity:0.8, color:"CanvasText" }}>← Back</a>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
        Org: {orgId} · Contract: {contractId} · Doc: <span style={{ fontFamily:"ui-monospace, Menlo, monospace" }}>{payloadId}</span>
      </div>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginTop: 14, alignItems:"center" }}>
        <Btn onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</Btn>
        <Btn onClick={save} disabled={busy || !parsed.ok} style={{ fontWeight: 900 }}>
          {busy ? "Working…" : "Save"}
        </Btn>
        {!parsed.ok && <div style={{ color:"crimson", fontWeight: 900 }}>Invalid JSON</div>}
        {banner && <div style={{ color:"#4ade80", fontWeight: 900 }}>{banner}</div>}
        {err && <div style={{ color:"crimson", fontWeight: 900 }}>{err}</div>}
      </div>

      <div style={{ marginTop: 14, display:"grid", gap:10 }}>
        <div style={{ opacity: 0.75, fontSize: 12 }}>
          Tip: paste valid JSON only. Save writes via <b>writeContractPayloadV1</b>.
        </div>

        <textarea
          value={text}
          onChange={(e)=>setText(e.target.value)}
          spellCheck={false}
          style={{
            width:"100%",
            minHeight: 520,
            padding: 12,
            borderRadius: 14,
            border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
            background: "color-mix(in oklab, CanvasText 2%, transparent)",
            color: "CanvasText",
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.4,
          }}
        />
      </div>
    </div>
  );
}
TSX
echo "✅ ui: /admin/contracts/[id]/payloads/[payloadId]"

echo "==> (3) Done. (Restart next if needed)"
echo "Try:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=org_001"
