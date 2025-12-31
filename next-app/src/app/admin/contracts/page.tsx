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
