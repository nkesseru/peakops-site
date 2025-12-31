// CONTRACTS V1 — FROZEN
// Do not modify behavior or schema without a version bump (v2).
// Safe edits: UI cosmetics, copy, logging.

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
