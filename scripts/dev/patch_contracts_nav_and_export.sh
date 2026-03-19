#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

cd ~/peakops/my-app

P_CONTRACTS_LIST="next-app/src/app/admin/contracts/page.tsx"
P_CONTRACT_DETAIL="next-app/src/app/admin/contracts/[id]/page.tsx"
P_PAYLOADS_LIST="next-app/src/app/admin/contracts/[id]/payloads/page.tsx"
P_PAYLOAD_EDITOR="next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"

mkdir -p "$(dirname "$P_CONTRACTS_LIST")" "$(dirname "$P_CONTRACT_DETAIL")" "$(dirname "$P_PAYLOADS_LIST")" "$(dirname "$P_PAYLOAD_EDITOR")"

ts="$(date +%Y%m%d_%H%M%S)"
for f in "$P_CONTRACTS_LIST" "$P_CONTRACT_DETAIL" "$P_PAYLOADS_LIST" "$P_PAYLOAD_EDITOR"; do
  if [[ -f "$f" ]]; then
    cp "$f" "$f.bak_${ts}"
    echo "✅ backup: $f.bak_${ts}"
  fi
done

# -------------------------
# Admin Contracts List
# -------------------------
cat > "$P_CONTRACTS_LIST" <<'TSX'
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
TSX
echo "✅ wrote: $P_CONTRACTS_LIST"

# -------------------------
# Admin Contract Detail + Export ZIP
# -------------------------
cat > "$P_CONTRACT_DETAIL" <<'TSX'
"use client";

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
TSX
echo "✅ wrote: $P_CONTRACT_DETAIL"

# -------------------------
# Admin Payloads List (links to editor)
# -------------------------
cat > "$P_PAYLOADS_LIST" <<'TSX'
"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

export default function AdminContractPayloads() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const orgId = sp.get("orgId") || "org_001";
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
TSX
echo "✅ wrote: $P_PAYLOADS_LIST"

# -------------------------
# Admin Payload Editor
# -------------------------
cat > "$P_PAYLOAD_EDITOR" <<'TSX'
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
TSX
echo "✅ wrote: $P_PAYLOAD_EDITOR"

echo
echo "✅ DONE. Restart next dev if needed:"
echo "  ( cd next-app && pnpm dev --port 3000 )"
echo
echo "Open:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=org_001"
