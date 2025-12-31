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
