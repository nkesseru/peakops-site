"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

export default function AdminPayloadEditor() {
  const params = useParams<{ id: string; payloadId: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const payloadId = params.payloadId;
  const orgId = sp.get("orgId") || "org_001";
  const versionId = sp.get("versionId") || "v1";

  const [doc, setDoc] = useState<any>(null);
  const [text, setText] = useState<string>("{\n  \"_placeholder\": \"INIT\"\n}\n");
  const [err, setErr] = useState<string>("");
  const [ok, setOk] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setErr("");
    setOk("");
    try {
      const r = await fetch(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");
      const found = (Array.isArray(j.docs) ? j.docs : []).find((x: any) => String(x.id) === String(payloadId));
      setDoc(found || null);
      setText(JSON.stringify((found?.payload ?? {}), null, 2) + "\n");
    } catch (e: any) {
      setErr(String(e?.message || e));
      setDoc(null);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setErr("");
    setOk("");
    try {
      let payloadObj: any;
      try {
        payloadObj = JSON.parse(text);
      } catch (e: any) {
        throw new Error(`The string did not match the expected pattern. ${String(e?.message || e)}`);
      }

      // derive type/schema from doc (preferred), else from payloadId
      const type = String(doc?.type || payloadId).toUpperCase();
      const schemaVersion = String(doc?.schemaVersion || "");

      const r = await fetch(`/api/fn/writeContractPayloadV1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          contractId,
          type,
          versionId,
          schemaVersion,
          payload: payloadObj,
          createdBy: "admin_ui",
        }),
      });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "writeContractPayloadV1 failed");
      setOk(`Saved ✅ ${j.payloadDocId || payloadId}`);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, [contractId, payloadId]); // eslint-disable-line

  const title = useMemo(() => {
    const t = doc?.type || payloadId;
    return String(t);
  }, [doc, payloadId]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>Admin · Payload Editor</h1>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
            Org: {mono(orgId)} · Contract: {mono(contractId)} · Doc: {mono(payloadId)} · Type: {mono(title)}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <a href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}&versionId=${encodeURIComponent(versionId)}`} style={{ textDecoration: "none", color: "CanvasText", opacity: 0.85 }}>← Payloads</a>

          <button
            onClick={load}
            disabled={busy}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              cursor: busy ? "not-allowed" : "pointer",
              fontWeight: 800,
            }}
          >
            Refresh
          </button>

          <button
            onClick={save}
            disabled={busy}
            style={{
              padding: "8px 12px",
              borderRadius: 12,
              border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, transparent)",
              cursor: busy ? "not-allowed" : "pointer",
              fontWeight: 900,
            }}
          >
            Save
          </button>
        </div>
      </div>

      {err && <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>{err}</div>}
      {ok && <div style={{ marginTop: 10, color: "lime", fontWeight: 900 }}>{ok}</div>}

      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
        Tip: paste valid JSON only. Save writes via <b>writeContractPayloadV1</b>.
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        style={{
          marginTop: 12,
          width: "100%",
          height: "68vh",
          padding: 12,
          borderRadius: 14,
          border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
          background: "color-mix(in oklab, CanvasText 2%, transparent)",
          color: "CanvasText",
          fontFamily: "ui-monospace, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.4,
          outline: "none",
        }}
      />
    </div>
  );
}
