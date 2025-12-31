// CONTRACTS V1 — FROZEN
// Do not modify behavior or schema without a version bump (v2).
// Safe edits: UI cosmetics, copy, logging.

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
