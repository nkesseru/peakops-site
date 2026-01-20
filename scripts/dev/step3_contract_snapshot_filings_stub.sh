#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

ROUTE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
BUNDLE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"

mkdir -p scripts/dev/_bak .logs

TS="$(date +%Y%m%d_%H%M%S)"

# --- backups
if [[ -f "$ROUTE" ]]; then
  cp "$ROUTE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
  echo "✅ backup: scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
fi
if [[ -f "$BUNDLE" ]]; then
  cp "$BUNDLE" "scripts/dev/_bak/bundle_page_${TS}.tsx"
  echo "✅ backup: scripts/dev/_bak/bundle_page_${TS}.tsx"
fi

# --- (1) Write a robust downloadIncidentPacketZip route (contract snapshot + filings stub + manifest/hashes + generatedAt)
cat > "$ROUTE" <<'TS'
import { NextResponse } from "next/server";
import crypto from "crypto";
import JSZip from "jszip";

export const runtime = "nodejs";

function sha256(buf: Uint8Array | Buffer) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function utf8(s: string) {
  return Buffer.from(s, "utf8");
}

async function safeJsonFetch(url: string) {
  const r = await fetch(url, { method: "GET" });
  const text = await r.text();
  if (!text || !text.trim()) return { ok: false, status: r.status, error: `empty body (HTTP ${r.status})`, raw: "" };
  try {
    const j = JSON.parse(text);
    return { ok: true, status: r.status, json: j, raw: text };
  } catch (e: any) {
    return { ok: false, status: r.status, error: String(e?.message || e), raw: text.slice(0, 400) };
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    const contractId = url.searchParams.get("contractId") || ""; // optional

    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
    }

    const nowIso = new Date().toISOString();
    const origin = url.origin;

    // Pull pieces via existing Next proxy endpoints
    const workflowRes = await safeJsonFetch(
      `${origin}/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`
    );
    const timelineRes = await safeJsonFetch(
      `${origin}/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`
    );

    const contractRes = contractId
      ? await safeJsonFetch(
          `${origin}/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`
        )
      : null;

    const payloadsRes = contractId
      ? await safeJsonFetch(
          `${origin}/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=200`
        )
      : null;

    // Build files list
    const files: { path: string; bytes: Uint8Array }[] = [];

    // README
    files.push({
      path: "README.txt",
      bytes: utf8(
        [
          "PeakOps Immutable Incident Artifact",
          `orgId=${orgId}`,
          `incidentId=${incidentId}`,
          contractId ? `contractId=${contractId}` : "contractId=(none)",
          `generatedAt=${nowIso}`,
          "",
          "This ZIP is an immutable shareable artifact for audits/evidence.",
        ].join("\n")
      ),
    });

    // workflow.json
    files.push({
      path: "workflow.json",
      bytes: utf8(JSON.stringify(workflowRes.ok ? workflowRes.json : { ok: false, error: workflowRes.error }, null, 2)),
    });

    // timeline/events.json
    files.push({
      path: "timeline/events.json",
      bytes: utf8(JSON.stringify(timelineRes.ok ? timelineRes.json : { ok: false, error: timelineRes.error }, null, 2)),
    });

    // contract snapshot if present
    if (contractRes?.ok) {
      files.push({
        path: "contract/contract.json",
        bytes: utf8(JSON.stringify(contractRes.json, null, 2)),
      });
    } else {
      // stub always exists so downstream structure stays stable
      files.push({
        path: "contract/contract.json",
        bytes: utf8(JSON.stringify({ ok: false, note: "No contract snapshot (missing contractId or not found)." }, null, 2)),
      });
    }

    // filings folder: either payload docs -> filings/*.json or a stub
    const payloadDocs = (payloadsRes?.ok && Array.isArray((payloadsRes.json as any)?.docs)) ? (payloadsRes.json as any).docs : [];
    if (payloadDocs.length) {
      for (const d of payloadDocs) {
        const id = String(d?.id || "");
        const type = String(d?.type || d?.schemaVersion || "payload");
        const name = (type || "payload").toLowerCase().replace(/[^a-z0-9_\\-\\.]/g, "_");
        const p = `filings/${name}__${id}.json`;
        files.push({ path: p, bytes: utf8(JSON.stringify(d, null, 2)) });
      }
    } else {
      files.push({
        path: "filings/README.txt",
        bytes: utf8(
          [
            "Filings folder stub",
            "",
            "This will contain DIRS/OE-417/NORS/SAR/BABA payload JSONs.",
            "Currently empty because payloads are not wired for incident-based generation yet.",
          ].join("\n")
        ),
      });
    }

    // hashes + manifest (computed before zip)
    const hashes: Record<string, string> = {};
    const manifest: { path: string; sha256: string; sizeBytes: number }[] = [];

    for (const f of files) {
      const h = sha256(f.bytes);
      hashes[f.path] = h;
      manifest.push({ path: f.path, sha256: h, sizeBytes: f.bytes.byteLength });
    }

    // packet_meta.json uses a stable packetHash derived from hashes.json
    const packetHash = sha256(utf8(JSON.stringify(hashes, null, 2)));

    const packetMeta = {
      orgId,
      incidentId,
      contractId: contractId || null,
      generatedAt: nowIso,
      packetHash,
      fileCount: files.length + 2, // +manifest +hashes
    };

    files.push({ path: "packet_meta.json", bytes: utf8(JSON.stringify(packetMeta, null, 2)) });
    files.push({ path: "manifest.json", bytes: utf8(JSON.stringify(manifest, null, 2)) });
    files.push({ path: "hashes.json", bytes: utf8(JSON.stringify(hashes, null, 2)) });

    // ZIP
    const zip = new JSZip();
    for (const f of files) zip.file(f.path, f.bytes);

    const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const zipSha = sha256(zipBytes);
    const filename = `incident_${incidentId}_packet.zip`;

    return new NextResponse(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-PeakOps-Zip-SHA256": zipSha,
        "X-PeakOps-Zip-Size": String(zipBytes.byteLength),
        "X-PeakOps-PacketHash": packetHash,
        "X-PeakOps-GeneratedAt": nowIso,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS
echo "✅ wrote: $ROUTE"

# --- (2) Write a clean bundle page that shows generatedAt + file list including contract + filings
cat > "$BUNDLE" <<'TSX'
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

        <button style={btn(false)} onClick={refreshMeta} disabled={busy}>
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
          <a href={downloadUrl} style={btn(false)}>
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
TSX
echo "✅ wrote: $BUNDLE"

# --- restart next + smoke
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke bundle page"
BURL="http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
curl -fsS "$BURL" >/dev/null || { echo "❌ bundle page failing"; tail -n 200 .logs/next.log; exit 1; }
echo "✅ bundle page OK"

echo "==> smoke download route (HEAD)"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123"
curl -fsSI "$DURL" | head -n 30

echo
echo "OPEN:"
echo "  $BURL"
echo
echo "✅ Step 3 complete (contract snapshot + filings stub + generatedAt + manifest/hashes)."
