#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FILE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

cp "$FILE" "scripts/dev/_bak/bundle_page_${TS}.tsx" 2>/dev/null || true
echo "✅ backup: scripts/dev/_bak/bundle_page_${TS}.tsx"

cat > "$FILE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";

type PacketMeta = {
  packetHash?: string;
  sizeBytes?: number;
  generatedAt?: string;
};

type ApiOk = { ok: true; orgId: string; incidentId: string; packetMeta?: PacketMeta };
type ApiErr = { ok: false; error: string };
type ApiResp = ApiOk | ApiErr;

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    padding: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  };
}

function btn(primary?: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: primary ? "color-mix(in oklab, CanvasText 10%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontWeight: 900,
    textDecoration: "none",
    display: "inline-block",
    cursor: "pointer",
  };
}

function safeJson(text: string): { ok: true; v: any } | { ok: false; err: string } {
  try {
    return { ok: true, v: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, err: String(e?.message || e) };
  }
}

export default function IncidentBundlePage() {
  const params = useParams() as any;
  const sp = useSearchParams();

  const orgId = sp.get("orgId") || "org_001";
  const incidentId = String(params?.id || "inc_TEST");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [packetMeta, setPacketMeta] = useState<PacketMeta | null>(null);

  const exportApi = useMemo(() => {
    return (
      `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}`
    );
  }, [orgId, incidentId]);

  const zipUrl = useMemo(() => {
    return (
      `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}`
    );
  }, [orgId, incidentId]);

  async function loadMeta() {
    setErr("");
    try {
      const r = await fetch(exportApi, { method: "GET" });
      const text = await r.text();
      const parsed = safeJson(text);
      if (!parsed.ok) throw new Error(`exportIncidentPacketV1 returned non-JSON (HTTP ${r.status}): ${parsed.err}`);
      const j = parsed.v as ApiResp;
      if ((j as any)?.ok === false) throw new Error(String((j as any)?.error || "exportIncidentPacketV1 failed"));
      setPacketMeta((j as any)?.packetMeta || null);
    } catch (e: any) {
      setPacketMeta(null);
      setErr(String(e?.message || e));
    }
  }

  async function generatePacket() {
    setBusy(true);
    setErr("");
    try {
      // This endpoint is our canonical “compute packet meta / refresh packet” call
      const r = await fetch(exportApi, { method: "GET" });
      const text = await r.text();
      const parsed = safeJson(text);
      if (!parsed.ok) throw new Error(`exportIncidentPacketV1 returned non-JSON (HTTP ${r.status}): ${parsed.err}`);
      const j = parsed.v as ApiResp;
      if ((j as any)?.ok === false) throw new Error(String((j as any)?.error || "exportIncidentPacketV1 failed"));
      setPacketMeta((j as any)?.packetMeta || null);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 950 }}>Immutable Incident Artifact</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>

        <button style={btn(false)} onClick={loadMeta} disabled={busy}>
          Refresh
        </button>
      </div>

      {err ? (
        <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>{err}</div>
      ) : null}

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 950, marginBottom: 8 }}>Packet Meta</div>

        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
          packetHash: <span style={{ fontFamily: "ui-monospace" }}>{packetMeta?.packetHash || "—"}</span>
          <br />
          sizeBytes: <span style={{ fontFamily: "ui-monospace" }}>{packetMeta?.sizeBytes ?? "—"}</span>
          <br />
          generatedAt: <span style={{ fontFamily: "ui-monospace" }}>{packetMeta?.generatedAt || "—"}</span>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
          <button onClick={generatePacket} disabled={busy} style={btn(true)} title="Generate/refresh packet meta (read-only export)">
            {busy ? "Generating…" : "Generate Packet"}
          </button>

          <a href={zipUrl} style={btn(false)}>
            Download Packet (ZIP)
          </a>
        </div>

        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
          This is the canonical “shareable artifact” for audits + evidence. (Read-only export)
        </div>
      </div>

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 950, marginBottom: 8 }}>Files (stub)</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Next: render a real file tree (manifest + hashes + payloads). For now, this is intentionally minimal + stable.
        </div>

        <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
{`contract/contract.json
timeline/events.json
filings/*.json
hashes.json
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
TSX

echo "✅ wrote clean bundle page: $FILE"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "==> smoke bundle page: $URL"
curl -fsS "$URL" >/dev/null \
  && echo "✅ bundle page OK" \
  || (echo "❌ bundle page failing"; tail -n 200 .logs/next.log; exit 1)

echo "OPEN:"
echo "  $URL"
