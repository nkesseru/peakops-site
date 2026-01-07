"use client";
import AdminNav from "../../../_components/AdminNav";
import JsonViewer from "../../../_components/JsonViewer";

import { useEffect, useState } from "react";
import {useParams, useSearchParams, useRouter} from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

export default function AdminContractPayloads() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const orgId = sp.get("orgId") || "org_001";
  const router = useRouter();
  // Normalize URL: always keep orgId in query (prevents orgId=undefined calls)
  useEffect(() => {
    const cur = sp.get("orgId");
    if (!cur) router.replace(`${location.pathname}?orgId=${encodeURIComponent(orgId)}`);
  }, [orgId]); // eslint-disable-line

  const versionId = sp.get("versionId") || "v1";

  const [docs, setDocs] = useState<any[]>([]);
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");
      setDocs(Array.isArray(j.docs) ? j.docs : []);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setDocs([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (contractId) load(); }, [contractId]); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      {/*__ADMIN_NAV__*/}
      <div style={{ marginTop: 10 }}>
        <AdminNav orgId={orgId} contractId={contractId} payloadId={typeof payloadId !== "undefined" ? payloadId : undefined} versionId={"v1"} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>Admin · Payloads</h1>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
            Org: {mono(orgId)} · Contract: {mono(contractId)} · Version: {mono(versionId)}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end" }}>
          <a href={`/admin/contracts/${encodeURIComponent(contractId)}?orgId=${encodeURIComponent(orgId)}&versionId=${encodeURIComponent(versionId)}`} style={{ textDecoration: "none", color: "CanvasText", opacity: 0.85 }}>← Contract</a>

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
        </div>
      </div>

      {err && <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>{err}</div>}
      {!err && <div style={{ marginTop: 10, opacity: 0.8 }}>Count: <b>{docs.length}</b></div>}

      <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
        {docs.map((d: any) => (
          <a
            key={d.id}
            href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads/${encodeURIComponent(d.id)}?orgId=${encodeURIComponent(orgId)}&versionId=${encodeURIComponent(versionId)}`}
            style={{
              textDecoration: "none",
              color: "CanvasText",
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              borderRadius: 14,
              padding: 12,
              background: "color-mix(in oklab, CanvasText 3%, transparent)",
            }}
          >
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
              <div style={{ fontWeight: 900 }}>{String(d.type || d.id)}</div>
              <div style={{ opacity: 0.75 }}>doc:</div> <div>{mono(String(d.id || ""))}</div>
              <div style={{ opacity: 0.75 }}>schema:</div> <div style={{ fontWeight: 800 }}>{String(d.schemaVersion || "—")}</div>
            </div>
            <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
              updatedAt: {String(d.updatedAt?._seconds ? new Date(d.updatedAt._seconds * 1000).toLocaleString() : d.updatedAt || "—")}
              {" · "}
              payloadHash: {mono(String(d.payloadHash || "—"))}
              {" · "}
              <span style={{ fontWeight: 900 }}>Open Editor →</span>
            </div>
          </a>
        ))}
        {docs.length === 0 && !err && <div style={{ opacity: 0.7 }}>No payload docs found.</div>}
      </div>
    </div>
  );
}