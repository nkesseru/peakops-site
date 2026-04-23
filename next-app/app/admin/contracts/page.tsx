"use client";
import AdminNav from "../_components/AdminNav";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

// PEAKOPS_SUSPENSE_CSR_BAILOUT_V1
// Next.js 16 requires every useSearchParams() caller to sit inside a Suspense
// boundary so static prerender can bail out cleanly. Wrapping the original
// component body keeps all behavior identical while satisfying the rule.
function AdminContractsListInner() {
  const sp = useSearchParams();
  const orgId = sp.get("orgId") || "org_001";
  const router = useRouter();

  // Normalize URL: always keep orgId in query (prevents orgId=undefined calls)
  useEffect(() => {
    const cur = sp.get("orgId");
    if (!cur) router.replace(`/admin/contracts?orgId=${encodeURIComponent(orgId)}`);
  }, [orgId]); // eslint-disable-line


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
      const msg = String(e?.message || e);
      setErr(
        msg.includes("does not exist")
          ? "This module requires backend services that are not deployed in this environment."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, [orgId]); // eslint-disable-line

  const count = useMemo(() => docs.length, [docs]);

  return (
    <div style={{ padding: "28px 24px", fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: "#fff", minHeight: "calc(100vh - 44px)", background: "#000" }}>
      <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Contracts</h1>
      <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>Org: {mono(orgId)}</div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
        <button
          onClick={load}
          disabled={busy}
          style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #1a1a1a", background: "#0a0a0a", color: "#ccc", fontSize: 12, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer" }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
        {!err && <span style={{ fontSize: 12, color: "#666" }}>Contracts: <b style={{ color: "#ccc" }}>{count}</b></span>}
      </div>

      {err && (
        <div style={{ marginTop: 16, padding: "20px 24px", borderRadius: 8, border: "1px solid #1a1a1a", background: "#0a0a0a", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "#777", lineHeight: 1.6 }}>{err}</div>
        </div>
      )}

      {!err && (
        <div style={{ marginTop: 16, border: "1px solid #1a1a1a", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "220px 180px 120px 120px 1fr", gap: 0, padding: "10px 14px", fontSize: 11, color: "#666", borderBottom: "1px solid #1a1a1a", background: "#050505" }}>
            <div>ID</div><div>Contract #</div><div>Type</div><div>Status</div><div>Customer</div>
          </div>

          {docs.map((d: any) => (
            <a
              key={d.id}
              href={`/admin/contracts/${encodeURIComponent(d.id)}?orgId=${encodeURIComponent(orgId)}`}
              style={{
                display: "grid",
                gridTemplateColumns: "220px 180px 120px 120px 1fr",
                padding: "12px 14px",
                textDecoration: "none",
                color: "#ccc",
                borderBottom: "1px solid #111",
                background: "#0a0a0a",
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 600, color: "#C8A84E", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{String(d.id)}</div>
              <div style={{ fontWeight: 600 }}>{String(d.contractNumber || "—")}</div>
              <div style={{ color: "#888" }}>{String(d.type || "—")}</div>
              <div style={{ color: "#888" }}>{String(d.status || "—")}</div>
              <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#888" }}>{String(d.customerId || "—")}</div>
            </a>
          ))}

          {docs.length === 0 && (
            <div style={{ padding: "16px 14px", color: "#555", fontSize: 13 }}>No contracts found.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminContractsList() {
  return (
    <Suspense fallback={null}>
      <AdminContractsListInner />
    </Suspense>
  );
}
