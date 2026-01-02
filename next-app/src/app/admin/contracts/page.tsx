"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

export default function AdminContractsList() {
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
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, [orgId]); // eslint-disable-line

  const count = useMemo(() => docs.length, [docs]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>Admin · Contracts</h1>
        <div style={{ fontSize: 12, opacity: 0.75 }}>Org: {mono(orgId)}</div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>

        {!err && <div style={{ opacity: 0.8 }}>Contracts: <b>{count}</b></div>}
        {err && <div style={{ color: "crimson", fontWeight: 900 }}>{err}</div>}
      </div>

      <div style={{ marginTop: 14, border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "220px 180px 120px 120px 1fr", gap: 0, padding: "10px 12px", fontSize: 12, opacity: 0.75, borderBottom: "1px solid color-mix(in oklab, CanvasText 12%, transparent)" }}>
          <div>ID</div><div>Contract #</div><div>Type</div><div>Status</div><div>Customer</div>
        </div>

        {docs.map((d: any) => (
          <a
            key={d.id}
            href={`/admin/contracts/${encodeURIComponent(d.id)}?orgId=${encodeURIComponent(orgId)}`}
            style={{
              display: "grid",
              gridTemplateColumns: "220px 180px 120px 120px 1fr",
              padding: "12px 12px",
              textDecoration: "none",
              color: "CanvasText",
              borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
              background: "color-mix(in oklab, CanvasText 2%, transparent)",
            }}
          >
            <div style={{ fontWeight: 800 }}>{mono(String(d.id))}</div>
            <div style={{ fontWeight: 900 }}>{String(d.contractNumber || "—")}</div>
            <div>{String(d.type || "—")}</div>
            <div>{String(d.status || "—")}</div>
            <div>{mono(String(d.customerId || "—"))}</div>
          </a>
        ))}

        {docs.length === 0 && !err && (
          <div style={{ padding: 12, opacity: 0.7 }}>No contracts found.</div>
        )}
      </div>
    </div>
  );
}
