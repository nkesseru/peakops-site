#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/contracts/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

mkdir -p .logs scripts/dev/_bak
cp "$FILE" "scripts/dev/_bak/contracts_id_page.$TS.tsx" 2>/dev/null || true
echo "✅ backup: scripts/dev/_bak/contracts_id_page.$TS.tsx"

cat > "$FILE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import AdminNav from "../../_components/AdminNav";
import PrettyJson from "../../_components/PrettyJson";

function pill(): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 700,
    opacity: 0.92,
    display: "inline-flex",
    gap: 8,
    alignItems: "center",
    cursor: "pointer",
    userSelect: "none",
  };
}

function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        padding: 14,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 10 }}>
        {props.title}
      </div>
      {props.children}
    </div>
  );
}

function safeJson(text: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function b64ToBlob(b64: string, mime = "application/zip") {
  const byteChars = atob(b64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mime });
}

export default function AdminContractDetail() {
  const params = useParams() as any;
  const sp = useSearchParams();

  const orgId = sp.get("orgId") || "org_001";
  const versionId = sp.get("versionId") || "v1";
  const contractId = String(params?.id || "");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [doc, setDoc] = useState<any>({});

  const payloadsHref = useMemo(
    () => `/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}`,
    [orgId, contractId]
  );

  const packetHref = useMemo(
    () =>
      `/admin/contracts/${encodeURIComponent(contractId)}/packet?orgId=${encodeURIComponent(orgId)}&versionId=${encodeURIComponent(
        versionId
      )}`,
    [orgId, contractId, versionId]
  );

  async function load() {
    if (!contractId) return;
    setBusy(true);
    setErr("");
    try {
      const url = `/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`;
      const r = await fetch(url, { method: "GET" });
      const text = await r.text();

      if (!text || !text.trim()) {
        setDoc({});
        setErr(`Contract API returned empty (HTTP ${r.status})`);
        return;
      }

      const parsed = safeJson(text);
      if (!parsed.ok) {
        setDoc({});
        setErr(`Contract API returned non-JSON (HTTP ${r.status}): ${parsed.error}`);
        return;
      }

      const j = parsed.value;

      if (j?.ok === false) {
        setDoc({});
        setErr(String(j?.error || "getContractV1 failed"));
        return;
      }

      // tolerate shapes: {doc}, {contract}, or raw object
      const d = j?.doc || j?.contract || j;
      if (!d || (typeof d === "object" && Object.keys(d).length === 0)) {
        setDoc({});
        setErr("Contract not found");
        return;
      }

      setDoc(d);
    } catch (e: any) {
      setDoc({});
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function downloadZip() {
    if (!contractId) return;
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/exportContractPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&contractId=${encodeURIComponent(contractId)}` +
        `&versionId=${encodeURIComponent(versionId)}` +
        `&limit=200`;
      const r = await fetch(url, { method: "GET" });
      const text = await r.text();

      if (!text || !text.trim()) {
        setErr(`Packet API empty (HTTP ${r.status})`);
        return;
      }

      const parsed = safeJson(text);
      if (!parsed.ok) {
        setErr(`Packet API non-JSON (HTTP ${r.status}): ${parsed.error}`);
        return;
      }

      const j = parsed.value;
      if (!j?.ok) {
        setErr(String(j?.error || `exportContractPacketV1 failed (HTTP ${r.status})`));
        return;
      }

      const b64 = String(j?.zipBase64 || "");
      if (!b64) {
        setErr("Packet API ok:true but zipBase64 missing.");
        return;
      }

      const blob = b64ToBlob(b64, "application/zip");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = String(j?.filename || `contract_packet_${contractId}.zip`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (contractId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, contractId]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <AdminNav orgId={orgId} contractId={contractId} versionId={versionId} />

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>Admin · Contract</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Org: <b>{orgId}</b> · Contract: <b>{contractId}</b> · Version: <b>{versionId}</b>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link style={pill()} href={`/admin/contracts?orgId=${encodeURIComponent(orgId)}`}>← Contracts</Link>
          <Link style={pill()} href={payloadsHref}>Payloads →</Link>
          <Link style={pill()} href={packetHref}>Preview Packet</Link>
          <button style={pill()} onClick={downloadZip} disabled={busy}>Download ZIP</button>
          <button style={pill()} onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</button>
        </div>
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 10, fontSize: 12, opacity: 0.85 }}>
        <div>Contract # <b>{doc?.contractNumber || "—"}</b></div>
        <div>Type <b>{doc?.type || "—"}</b></div>
        <div>Status <b>{doc?.status || "—"}</b></div>
        <div>Customer <b>{doc?.customerId || "—"}</b></div>
      </div>

      <div style={{ marginTop: 14, display: "grid", gap: 14 }}>
        <Panel title="Overview">
          {err ? <div style={{ color: "crimson", fontWeight: 900, marginBottom: 10 }}>{err}</div> : null}
          <PrettyJson value={doc} />
        </Panel>

        <div style={{ opacity: 0.65, fontSize: 12 }}>
          Tip: this is the live contract object. Packet Preview is the “shareable artifact.”
        </div>
      </div>
    </div>
  );
}
TSX

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke (contract detail)"
curl -fsSI "http://127.0.0.1:3000/admin/contracts/car_abc123?orgId=org_001" | head -n 12 || true
echo
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
