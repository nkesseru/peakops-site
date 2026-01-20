#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="${1:-$HOME/peakops/my-app}"
NEXT_DIR="$ROOT/next-app"
LOGDIR="$ROOT/.logs"
TS="$(date +%Y%m%d_%H%M%S)"

BUNDLE_PAGE="$NEXT_DIR/src/app/admin/incidents/[id]/bundle/page.tsx"
BUNDLE_ZIP_ROUTE="$NEXT_DIR/src/app/api/fn/downloadIncidentBundleZip/route.ts"

mkdir -p "$LOGDIR" "$ROOT/scripts/dev/_bak"
mkdir -p "$(dirname "$BUNDLE_PAGE")"
mkdir -p "$(dirname "$BUNDLE_ZIP_ROUTE")"

echo "==> ROOT=$ROOT"
echo "==> NEXT_DIR=$NEXT_DIR"

# --- backups
if [ -f "$BUNDLE_PAGE" ]; then
  cp "$BUNDLE_PAGE" "$ROOT/scripts/dev/_bak/bundle_page_$TS.tsx"
  echo "✅ backup bundle page -> scripts/dev/_bak/bundle_page_$TS.tsx"
fi
if [ -f "$BUNDLE_ZIP_ROUTE" ]; then
  cp "$BUNDLE_ZIP_ROUTE" "$ROOT/scripts/dev/_bak/downloadIncidentBundleZip_route_$TS.ts"
  echo "✅ backup bundle zip route -> scripts/dev/_bak/downloadIncidentBundleZip_route_$TS.ts"
fi

# --- write bundle zip route (wraps packet.zip into bundle.zip)
cat > "$BUNDLE_ZIP_ROUTE" <<'TS'
import JSZip from "jszip";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// NOTE: Keep this route dead-simple + stable.
// It creates a bundle.zip that contains:
//  - packet.zip  (the canonical immutable packet zip you already generate)
//  - bundle_manifest.json  (tiny metadata + file list)
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    const contractId = url.searchParams.get("contractId") || "";

    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
    }

    // Fetch the canonical packet zip from our existing endpoint.
    const packetUrl =
      `${url.origin}/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}` +
      (contractId ? `&contractId=${encodeURIComponent(contractId)}` : "");

    const packetRes = await fetch(packetUrl, { method: "GET" });
    if (!packetRes.ok) {
      const sample = await packetRes.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `downloadIncidentPacketZip failed (HTTP ${packetRes.status})`, sample: sample.slice(0, 400) },
        { status: 502 }
      );
    }

    const packetBytes = new Uint8Array(await packetRes.arrayBuffer());

    const generatedAt = new Date().toISOString();
    const bundleManifest = {
      bundleVersion: "v1",
      generatedAt,
      orgId,
      incidentId,
      contractId: contractId || null,
      files: [
        { path: "packet.zip", note: "Canonical immutable incident packet zip" },
        { path: "bundle_manifest.json", note: "Bundle metadata (this file)" },
      ],
    };

    const zip = new JSZip();
    zip.file("packet.zip", packetBytes);
    zip.file("bundle_manifest.json", JSON.stringify(bundleManifest, null, 2));

    const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const filename = `incident_${incidentId}_bundle.zip`;

    return new NextResponse(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-PeakOps-Bundle-GeneratedAt": generatedAt,
        "X-PeakOps-Bundle-Size": String(zipBytes.byteLength),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

// Some browsers / tooling like a HEAD probe.
// Keep it consistent with GET headers.
export async function HEAD(req: Request) {
  const r = await GET(req);
  // strip body if any
  return new NextResponse(null, { status: r.status, headers: r.headers });
}
TS
echo "✅ wrote $BUNDLE_ZIP_ROUTE"

# --- write bundle page (clean, no broken useMemo)
cat > "$BUNDLE_PAGE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

type PacketMeta = {
  packetHash?: string;
  zipSize?: number;
  generatedAt?: string;
};

type ExportResp =
  | { ok: true; orgId: string; incidentId: string; packetMeta?: PacketMeta }
  | { ok: false; error: string };

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
    border: primary
      ? "1px solid color-mix(in oklab, lime 45%, transparent)"
      : "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: primary
      ? "color-mix(in oklab, lime 18%, transparent)"
      : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontWeight: 900,
    textDecoration: "none",
    display: "inline-block",
    cursor: "pointer",
    userSelect: "none",
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
  const contractId = sp.get("contractId") || ""; // optional

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [packetMeta, setPacketMeta] = useState<PacketMeta | null>(null);

  const packetZipUrl = useMemo(() => {
    return (
      `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}` +
      (contractId ? `&contractId=${encodeURIComponent(contractId)}` : "")
    );
  }, [orgId, incidentId, contractId]);

  const bundleZipUrl = useMemo(() => {
    return (
      `/api/fn/downloadIncidentBundleZip?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}` +
      (contractId ? `&contractId=${encodeURIComponent(contractId)}` : "")
    );
  }, [orgId, incidentId, contractId]);

  async function refreshMeta() {
    setErr("");
    try {
      // HEAD packet zip to read packet headers (packetHash, generatedAt, size)
      const r = await fetch(packetZipUrl, { method: "HEAD" });
      if (!r.ok) throw new Error(`HEAD packet download failed (HTTP ${r.status})`);
      const packetHash = r.headers.get("x-peakops-packethash") || "";
      const generatedAt = r.headers.get("x-peakops-generatedat") || "";
      const zipSize = Number(r.headers.get("x-peakops-zip-size") || "0") || 0;
      setPacketMeta({ packetHash, generatedAt, zipSize });
    } catch (e: any) {
      setPacketMeta(null);
      setErr(String(e?.message || e));
    }
  }

  async function generatePacket() {
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(url, { method: "GET" });
      const text = await r.text();
      const parsed = safeJson(text);

      if (!parsed.ok) {
        const sample = text.slice(0, 160).replace(/\s+/g, " ");
        throw new Error(`exportIncidentPacketV1 non-JSON (HTTP ${r.status}): ${parsed.err} — ${sample}`);
      }
      const j = parsed.v as ExportResp;
      if ((j as any)?.ok === false) throw new Error(String((j as any)?.error || "exportIncidentPacketV1 failed"));

      // Refresh displayed meta after generation
      await refreshMeta();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refreshMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId, contractId]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 950 }}>Immutable Incident Artifact</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>
        <button onClick={refreshMeta} style={btn(false)}>Refresh</button>
      </div>

      {err && (
        <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      )}

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 950, marginBottom: 6 }}>Packet Meta</div>
        <div style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.6 }}>
          packetHash: <span style={{ opacity: 0.9 }}>{packetMeta?.packetHash || "—"}</span>
          <br />
          zipSize: <span style={{ opacity: 0.9 }}>{packetMeta?.zipSize ? String(packetMeta.zipSize) : "—"}</span>
          <br />
          generatedAt: <span style={{ opacity: 0.9 }}>{packetMeta?.generatedAt || "—"}</span>
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={generatePacket} disabled={busy} style={btn(true)}>
            {busy ? "Generating…" : "Generate Packet"}
          </button>

          <a href={packetZipUrl} style={btn(false)}>
            Download Packet (ZIP)
          </a>

          <a href={bundleZipUrl} style={btn(false)}>
            Download Bundle (ZIP)
          </a>
        </div>

        <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>
          Packet = canonical “shareable artifact” for audits + evidence. Bundle = packet.zip + bundle_manifest.json.
        </div>
      </div>

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 950, marginBottom: 6 }}>Files (stub)</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
          Next: render a real file tree (manifest + hashes + payloads). For now, intentionally minimal + stable.
        </div>
        <pre style={{ fontSize: 12, opacity: 0.85, whiteSpace: "pre-wrap" }}>
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

      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.75 }}>
        <Link href={`/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`} style={{ color: "inherit" }}>
          ← Back to Incident
        </Link>
      </div>
    </div>
  );
}
TSX
echo "✅ wrote $BUNDLE_PAGE"

# --- restart next
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$LOGDIR"
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
sleep 2

BASE="http://127.0.0.1:3000"
echo "==> smoke bundle page"
BURL="$BASE/admin/incidents/inc_TEST/bundle?orgId=org_001"
curl -fsS "$BURL" >/dev/null && echo "✅ bundle page loads"

echo "==> smoke bundle zip HEAD"
curl -fsSI "$BASE/api/fn/downloadIncidentBundleZip?orgId=org_001&incidentId=inc_TEST" | head -n 20

echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BURL"
echo
echo "LOGS:"
echo "  tail -n 160 $LOGDIR/next.log"
