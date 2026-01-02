"use client";

import AdminNav from "../../_components/AdminNav";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

function safeJsonParse(s: string) {
  try { return { ok: true as const, v: JSON.parse(s) }; } catch (e: any) { return { ok: false as const, err: String(e?.message || e) }; }
}

export default function AdminContractDetail() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const orgId = sp.get("orgId") || "org_001";
  const versionId = sp.get("versionId") || "v1";

  const [doc, setDoc] = useState<any>(null);
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [busyZip, setBusyZip] = useState(false);

  
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

async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractV1 failed");
      setDoc(j.doc || null);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setDoc(null);
    } finally {
      setBusy(false);
    }
  }

  async function downloadZip() {
    setBusyZip(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/exportContractPacketV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&versionId=${encodeURIComponent(versionId)}&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "exportContractPacketV1 failed");
      const b64 = String(j.zipBase64 || "");
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/zip" });

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = j.filename || `peakops_contractpacket_${contractId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusyZip(false);
    }
  }

  useEffect(() => { if (contractId) load(); }, [contractId]); // eslint-disable-line

  const pretty = useMemo(() => {
    if (!doc) return "null";
    try { return JSON.stringify(doc, null, 2); } catch { return String(doc); }
  }, [doc]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ marginBottom: 14 }}><AdminNav active="contracts" /></div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.1 }}>Admin · Contract</div>
          <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.1 }}>{mono(contractId)}</div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>Org: {mono(orgId)}</div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <a href={`/admin/contracts?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none", color: "CanvasText", opacity: 0.85 }}>← Contracts</a>

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
            {busy ? "Refreshing…" : "Refresh"}
          </button>

          <a
            href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}&versionId=${encodeURIComponent(versionId)}`}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              textDecoration: "none",
              color: "CanvasText",
              fontWeight: 800,
            }}
          >
            Payloads →
          </a>

          <button
            onClick={downloadZip}
            disabled={busyZip}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              cursor: busyZip ? "not-allowed" : "pointer",
              fontWeight: 900,
            }}
            title="Exports a shareable audit-ready packet (contract + payloads + hashes)"
          >
            {busyZip ? "Building ZIP…" : "Download Contract Packet ZIP"}
          </button>
        </div>
      </div>

      {err && <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>{err}</div>}

      <div style={{ marginTop: 16 }}>
        <div
          style={{
            border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
            borderRadius: 14,
            padding: 12,
            background: "color-mix(in oklab, CanvasText 3%, transparent)",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Overview</div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>{pretty}</pre>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
        Tip: keep Contract Packet export as the canonical “shareable artifact” for audits + evidence.
      </div>
    </div>
  );
}
