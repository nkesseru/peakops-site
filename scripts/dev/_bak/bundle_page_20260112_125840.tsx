"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

type PacketMeta = {
  packetHash?: string;
  sizeBytes?: number;
  generatedAt?: string;
  zipSha256?: string;
  zipSize?: number;
};

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    padding: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  };
}

function btn(primary = false): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: primary ? "color-mix(in oklab, CanvasText 12%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    fontWeight: 900,
    textDecoration: "none",
    display: "inline-block",
    cursor: "pointer",
  };
}

function mono(): React.CSSProperties {
  return { fontFamily: "ui-monospace", fontSize: 12, opacity: 0.9 };
}

export default function BundlePage() {
  const params = useParams() as any;
  const sp = useSearchParams();

  const orgId = sp.get("orgId") || "org_001";
  const incidentId = String(params.id || "inc_TEST");

  const bundleZipUrl = useMemo(
    () => ,
    [orgId, incidentId]
  );
  const contractId = sp.get("contractId") || "car_abc123"; // optional; keeps demo useful

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [packetMeta, setPacketMeta] = useState<PacketMeta | null>(null);

  const downloadUrl = useMemo(() => {
    return `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&contractId=${encodeURIComponent(contractId)}`;
  }, [orgId, incidentId, contractId]);

  async function refreshMeta() {
    // Meta is derived from the export endpoint response headers (cheap + canonical)
    setErr("");
    try {
      const r = await fetch(downloadUrl, { method: "HEAD" });
      if (!r.ok) throw new Error(`HEAD download failed (HTTP ${r.status})`);

      setPacketMeta({
        packetHash: r.headers.get("x-peakops-packethash") || undefined,
        generatedAt: r.headers.get("x-peakops-generatedat") || undefined,
        zipSha256: r.headers.get("x-peakops-zip-sha256") || undefined,
        zipSize: r.headers.get("x-peakops-zip-size") ? Number(r.headers.get("x-peakops-zip-size")) : undefined,
      });
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  }

  async function generatePacket() {
    // For now, "Generate" = call the export function to compute packet meta on backend side (if you have one),
    // then refresh meta by HEAD-ing the download route.
    setBusy(true);
    setErr("");
    try {
      // If you have an export function route already, call it here; otherwise we just refresh.
      await refreshMeta();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refreshMeta(); }, [downloadUrl]);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div>
          <h1 style={{ margin: 0 }}>Immutable Incident Artifact</h1>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>

        <button style={btn()} onClick={refreshMeta} disabled={busy}>
          Refresh
        </button>
      </div>

      {err ? (
        <div style={{ marginTop: 12, color: "crimson", fontWeight: 900 }}>{err}</div>
      ) : null}

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Packet Meta</div>
        <div style={{ display: "grid", gap: 4 }}>
          <div style={mono()}>packetHash: {packetMeta?.packetHash || "—"}</div>
          <div style={mono()}>zipSize: {packetMeta?.zipSize ?? "—"}</div>
          <div style={mono()}>generatedAt: {packetMeta?.generatedAt || "—"}</div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <button onClick={generatePacket} disabled={busy} style={btn(true)}>
            {busy ? "Generating…" : "Generate Packet"}
          </button>
          <a href={downloadUrl} style={btn()}>
            Download Packet (ZIP)
          </a>
        </div>

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
          This is the canonical “shareable artifact” for audits + evidence. (Read-only export)
        </div>
      </div>

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 900 }}>Files (stub)</div>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
          Next: render a real file tree (manifest + hashes + payloads). For now, this is intentionally minimal + stable.
        </div>

        <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
{`README.txt
packet_meta.json
manifest.json
hashes.json
workflow.json
timeline/events.json
contract/contract.json
filings/*.json
packet.zip`}
        </pre>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
        <Link href={`/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none" }}>
          ← Back to Incident
        </Link>
      </div>
    </div>
  );
}
