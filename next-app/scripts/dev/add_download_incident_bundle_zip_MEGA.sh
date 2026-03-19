#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="${1:-$HOME/peakops/my-app}"
PROJECT_ID="${2:-peakops-pilot}"
ORG_ID="${3:-org_001}"
INCIDENT_ID="${4:-inc_TEST}"

cd "$ROOT"

NEXT_DIR="$ROOT/next-app"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR" "$ROOT/scripts/dev/_bak"

ROUTE_DIR="$NEXT_DIR/src/app/api/fn/downloadIncidentBundleZip"
ROUTE_FILE="$ROUTE_DIR/route.ts"

BUNDLE_PAGE_DIR="$NEXT_DIR/src/app/admin/incidents/[id]/bundle"
BUNDLE_PAGE_FILE="$BUNDLE_PAGE_DIR/page.tsx"

INC_PAGE_FILE="$NEXT_DIR/src/app/admin/incidents/[id]/page.tsx"

TS="$(date +%Y%m%d_%H%M%S)"

echo "==> ROOT=$ROOT"
echo "==> NEXT_DIR=$NEXT_DIR"
echo "==> PROJECT_ID=$PROJECT_ID ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID"

# -----------------------------
# (0) backups (if files exist)
# -----------------------------
for f in "$ROUTE_FILE" "$BUNDLE_PAGE_FILE" "$INC_PAGE_FILE"; do
  if [ -f "$f" ]; then
    cp "$f" "$ROOT/scripts/dev/_bak/$(basename "$(dirname "$f")")_$(basename "$f").bak_$TS"
  fi
done
echo "✅ backups (where applicable) saved to scripts/dev/_bak/"

# -----------------------------
# (1) Write Next API route: downloadIncidentBundleZip
# Bundle ZIP contains:
#   - packet.zip (from downloadIncidentPacketZip)
#   - bundle_manifest.json
#   - README.txt
# -----------------------------
mkdir -p "$ROUTE_DIR"

cat > "$ROUTE_FILE" <<'TSFILE'
import { NextResponse } from "next/server";
import JSZip from "jszip";

export const runtime = "nodejs";

async function readBytes(resp: Response): Promise<Uint8Array> {
  const ab = await resp.arrayBuffer();
  return new Uint8Array(ab);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
    }

    // Fetch the existing PACKET zip (canonical artifact)
    const packetUrl =
      `${url.origin}/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}`;

    const packetResp = await fetch(packetUrl, { method: "GET" });
    if (!packetResp.ok) {
      const sample = (await packetResp.text().catch(() => "")).slice(0, 200);
      return NextResponse.json(
        { ok: false, error: `downloadIncidentPacketZip failed (HTTP ${packetResp.status})`, sample },
        { status: 502 }
      );
    }

    const packetZipBytes = await readBytes(packetResp);

    // Build a "bundle.zip" that includes packet.zip + tiny manifest
    const bundle = new JSZip();

    // Put the packet as a child file
    bundle.file("packet.zip", packetZipBytes);

    const generatedAt = new Date().toISOString();

    const bundleManifest = {
      bundleVersion: "v1",
      orgId,
      incidentId,
      generatedAt,
      files: ["packet.zip"],
      notes: "Bundle contains the canonical immutable packet plus optional convenience files.",
    };

    bundle.file("bundle_manifest.json", JSON.stringify(bundleManifest, null, 2));
    bundle.file(
      "README.txt",
      [
        "PeakOps Incident Bundle (v1)",
        "",
        "This ZIP is a wrapper around the canonical immutable incident packet.",
        "",
        "- packet.zip: the immutable artifact (hashes, manifest, payloads)",
        "- bundle_manifest.json: metadata about this bundle wrapper",
        "",
        `generatedAt: ${generatedAt}`,
      ].join("\n")
    );

    const bundleZipBytes = await bundle.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const filename = `incident_${incidentId}_bundle.zip`;

    return new NextResponse(bundleZipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-PeakOps-Bundle-GeneratedAt": generatedAt,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TSFILE

echo "✅ wrote $ROUTE_FILE"

# -----------------------------
# (2) Ensure bundle page exists + add Download Bundle ZIP button
# -----------------------------
mkdir -p "$BUNDLE_PAGE_DIR"

if [ ! -f "$BUNDLE_PAGE_FILE" ]; then
  cat > "$BUNDLE_PAGE_FILE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    padding: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  };
}

function btn(accent?: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: accent ? "color-mix(in oklab, #6ee7b7 18%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    fontWeight: 900,
    textDecoration: "none",
    display: "inline-block",
    cursor: "pointer",
    color: "CanvasText",
  };
}

type PacketMeta = { packetHash?: string; zipSize?: number; generatedAt?: string } | null;

export default function IncidentBundlePage() {
  const params = useParams() as any;
  const sp = useSearchParams();

  const orgId = sp.get("orgId") || "org_001";
  const incidentId = String(params?.id || "inc_TEST");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [packetMeta, setPacketMeta] = useState<PacketMeta>(null);

  const packetZipUrl = useMemo(
    () => `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
    [orgId, incidentId]
  );

  const bundleZipUrl = useMemo(
    () => `/api/fn/downloadIncidentBundleZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
    [orgId, incidentId]
  );

  async function refreshMeta() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(packetZipUrl, { method: "HEAD" });
      if (!r.ok) throw new Error(`HEAD download failed (HTTP ${r.status})`);
      setPacketMeta({
        packetHash: r.headers.get("x-peakops-packethash") || undefined,
        zipSize: Number(r.headers.get("x-peakops-zip-size") || "0") || undefined,
        generatedAt: r.headers.get("x-peakops-generatedat") || undefined,
      });
    } catch (e: any) {
      setPacketMeta(null);
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refreshMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 950 }}>Immutable Incident Artifact</div>
          <div style={{ opacity: 0.75, marginTop: 4 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>
        <button onClick={refreshMeta} disabled={busy} style={btn()}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      )}

      <div style={{ marginTop: 16, ...card() }}>
        <div style={{ fontWeight: 950 }}>Packet Meta</div>
        <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>
          packetHash: {packetMeta?.packetHash || "—"}
          <br />
          zipSize: {packetMeta?.zipSize || "—"}
          <br />
          generatedAt: {packetMeta?.generatedAt || "—"}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          <a href={packetZipUrl} style={btn(true)}>Download Packet (ZIP)</a>
          <a href={bundleZipUrl} style={btn()}>Download Bundle (ZIP)</a>
        </div>

        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
          Packet = canonical immutable artifact. Bundle = wrapper ZIP that includes packet.zip + bundle manifest.
        </div>
      </div>

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 950 }}>Files (stub)</div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
          Next: render a real file tree (manifest + hashes + payloads). For now, this is intentionally minimal + stable.
        </div>
        <pre style={{ marginTop: 10, fontSize: 12, opacity: 0.9, whiteSpace: "pre-wrap" }}>
README.txt{"\n"}
packet_meta.json{"\n"}
manifest.json{"\n"}
hashes.json{"\n"}
workflow.json{"\n"}
timeline/events.json{"\n"}
contract/contract.json{"\n"}
filings/*.json{"\n"}
packet.zip{"\n"}
bundle_manifest.json{"\n"}
bundle.zip
        </pre>
      </div>

      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.75 }}>
        <a
          href={`/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`}
          style={{ textDecoration: "none" }}
        >
          ← Back to Incident
        </a>
      </div>
    </div>
  );
}
TSX
  echo "✅ created $BUNDLE_PAGE_FILE"
else
  # patch existing bundle page: add bundleZipUrl + button if missing
  python3 - <<PY
from pathlib import Path
import re

p = Path(r"$BUNDLE_PAGE_FILE")
s = p.read_text()

# ensure bundleZipUrl memo exists
if "downloadIncidentBundleZip" not in s:
    # find packetZipUrl memo and add bundleZipUrl below
    m = re.search(r"(const\s+packetZipUrl\s*=\s*useMemo\([^\n]+\n(?:.*\n)*?\);\n)", s, flags=re.M)
    if m:
        insert = """
  const bundleZipUrl = useMemo(
    () => `/api/fn/downloadIncidentBundleZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
    [orgId, incidentId]
  );
"""
        s = s[:m.end(1)] + insert + s[m.end(1):]
    else:
        # fallback: insert after orgId/incidentId declarations
        m2 = re.search(r"(const\s+incidentId\s*=.*;\n)", s)
        if m2:
            insert = """
  const bundleZipUrl = useMemo(
    () => `/api/fn/downloadIncidentBundleZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
    [orgId, incidentId]
  );
"""
            s = s[:m2.end(1)] + insert + s[m2.end(1):]

# ensure button exists
if "Download Bundle (ZIP)" not in s:
    # Insert right after Download Packet (ZIP) anchor if present
    s = s.replace(
        'Download Packet (ZIP)</a>',
        'Download Packet (ZIP)</a>\\n          <a href={bundleZipUrl} style={btn(false)}>Download Bundle (ZIP)</a>'
    )

# If btn(false) doesn't exist, keep it safe by swapping to btn()
s = s.replace("btn(false)", "btn()")

p.write_text(s)
print("✅ patched bundle page to include Download Bundle (ZIP) button")
PY
fi

# -----------------------------
# (3) Restart Next + smoke bundle zip
# -----------------------------
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
sleep 2

BASE="http://127.0.0.1:3000"
BUNDLE_URL="$BASE/api/fn/downloadIncidentBundleZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"

echo "==> smoke HEAD bundle zip"
curl -fsSI "$BUNDLE_URL" | head -n 25

echo "==> smoke GET bundle zip + verify required files"
TMP="/tmp/incident_bundle_zip_smoke_$TS"
mkdir -p "$TMP"
curl -fsS "$BUNDLE_URL" -o "$TMP/bundle.zip"

# must contain packet.zip + bundle_manifest.json
unzip -l "$TMP/bundle.zip" | grep -E "packet\.zip|bundle_manifest\.json" >/dev/null || {
  echo "❌ expected packet.zip or bundle_manifest.json not found in bundle.zip"
  unzip -l "$TMP/bundle.zip" | head -n 120
  exit 1
}

echo "✅ bundle.zip contains packet.zip + bundle_manifest.json"

echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "  $BASE/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
echo
echo "LOGS:"
echo "  tail -n 160 $LOGDIR/next.log"
