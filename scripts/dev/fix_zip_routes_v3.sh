#!/usr/bin/env bash
set -euo pipefail

# Make zsh harmless if this script is launched from zsh
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

PKT="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
BND="next-app/src/app/api/fn/downloadIncidentBundleZip/route.ts"

test -f "$PKT" || { echo "❌ missing $PKT"; exit 1; }
test -f "$BND" || { echo "❌ missing $BND"; exit 1; }

cp "$PKT" "$PKT.bak_$(date +%Y%m%d_%H%M%S)"
cp "$BND" "$BND.bak_$(date +%Y%m%d_%H%M%S)"
echo "✅ backups saved"

# -----------------------------
# Packet ZIP route (DETERMINISTIC)
# -----------------------------
cat > "$PKT" <<'TS'
import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import crypto from "crypto";

export const dynamic = "force-dynamic";

type AnyJson = any;

function sha256Hex(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return crypto.createHash("sha256").update(b).digest("hex");
}

function stableJson(obj: AnyJson): string {
  // Basic stable stringify: sort object keys recursively
  const seen = new WeakSet();
  const norm = (v: any): any => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return null;
      seen.add(v);
      if (Array.isArray(v)) return v.map(norm);
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(obj), null, 2);
}

async function getJsonSameOrigin(req: NextRequest, path: string): Promise<any> {
  const url = new URL(req.url);
  const u = `${url.origin}${path}`;
  const r = await fetch(u, { method: "GET", cache: "no-store" });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch {
    throw new Error(`non-json from ${path}: ${text.slice(0, 160)}`);
  }
  if (!r.ok || j?.ok === false) {
    throw new Error(j?.error || `HTTP ${r.status} from ${path}`);
  }
  return j;
}

export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url);
    const orgId = u.searchParams.get("orgId") || "";
    const incidentId = u.searchParams.get("incidentId") || "";
    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "missing orgId or incidentId" }, { status: 400 });
    }

    // Pull canonical sources (all same-origin /api/fn routes)
    const bundle = await getJsonSameOrigin(req, `/api/fn/getIncidentBundleV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    const timeline = await getJsonSameOrigin(req, `/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`).catch(() => ({ ok: true, docs: [] }));
    const workflow = await getJsonSameOrigin(req, `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`).catch(() => ({ ok: true }));

    // Packet meta (if present) gives us the canonical exportedAt + packetHash
    const metaResp = await getJsonSameOrigin(req, `/api/fn/getIncidentPacketMetaV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`).catch(() => ({ ok: true, packetMeta: null }));
    const packetMeta = metaResp?.packetMeta || null;

    // Deterministic “generatedAt”:
    // - if packetMeta.exportedAt exists, use it
    // - else fixed epoch so ZIP sha stays stable during dev
    const generatedAtIso = (packetMeta?.exportedAt || "2000-01-01T00:00:00.000Z") as string;
    const fixedZipDate = new Date(generatedAtIso);

    // Build canonical files
    const files: Record<string, string> = {};
    files["README.txt"] = [
      "PEAKOPS Incident Packet",
      `orgId=${orgId}`,
      `incidentId=${incidentId}`,
      `generatedAt=${generatedAtIso}`,
      "",
      "This packet is intended to be shareable + auditable.",
    ].join("\n");

    files["packet_meta.json"] = stableJson({
      orgId,
      incidentId,
      generatedAt: generatedAtIso,
      packetHash: packetMeta?.packetHash || null,
      exportedAt: packetMeta?.exportedAt || null,
      sizeBytes: packetMeta?.sizeBytes || null,
      filingsCount: packetMeta?.filingsCount ?? (bundle?.filings?.length ?? null),
      timelineCount: packetMeta?.timelineCount ?? (timeline?.docs?.length ?? null),
      source: packetMeta?.source || "downloadIncidentPacketZip",
    });

    files["workflow.json"] = stableJson(workflow);
    files["timeline/events.json"] = stableJson({ ok: true, orgId, incidentId, docs: timeline?.docs || [] });

    files["contract/contract.json"] = stableJson(bundle?.contract || bundle?.incident || {});
    files["filings/index.json"] = stableJson({
      ok: true,
      orgId,
      incidentId,
      filings: (bundle?.filings || []).map((f: any) => ({ id: f?.id, type: f?.type, status: f?.status, title: f?.title, updatedAt: f?.updatedAt })),
    });

    for (const f of (bundle?.filings || [])) {
      const id = String(f?.id || "unknown");
      files[`filings/${id}.json`] = stableJson(f);
    }

    // Hashes + manifest (stable ordering)
    const paths = Object.keys(files).sort();
    const hashes: Record<string, string> = {};
    const manifest = { files: [] as Array<{ path: string; bytes: number; sha256: string }> };

    for (const pth of paths) {
      const content = files[pth];
      const buf = Buffer.from(content, "utf8");
      const h = sha256Hex(buf);
      hashes[pth] = h;
      manifest.files.push({ path: pth, bytes: buf.length, sha256: h });
    }

    files["hashes.json"] = stableJson(hashes);
    files["manifest.json"] = stableJson(manifest);

    // Deterministic packetHash: sha256(manifest.json + hashes.json)
    const computedPacketHash = sha256Hex(files["manifest.json"] + "\n" + files["hashes.json"]);
    const packetHash = packetMeta?.packetHash || computedPacketHash;

    // Zip (stable timestamps)
    const zip = new JSZip();
    for (const pth of Object.keys(files).sort()) {
      zip.file(pth, files[pth], { date: fixedZipDate });
    }

    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const zipSha256 = sha256Hex(buf);

    const res = new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="incident_${incidentId}_packet.zip"`,
        "x-peakops-generatedat": generatedAtIso,
        "x-peakops-packethash": packetHash,
        "x-peakops-zip-sha256": zipSha256,
        "x-peakops-zip-size": String(buf.length),
      },
    });
    return res;
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS

# -----------------------------
# Bundle ZIP route (packet.zip + bundle_manifest.json)
# -----------------------------
cat > "$BND" <<'TS'
import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import crypto from "crypto";

export const dynamic = "force-dynamic";

function sha256Hex(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return crypto.createHash("sha256").update(b).digest("hex");
}

export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url);
    const orgId = u.searchParams.get("orgId") || "";
    const incidentId = u.searchParams.get("incidentId") || "";
    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "missing orgId or incidentId" }, { status: 400 });
    }

    const origin = new URL(req.url).origin;

    // Fetch packet.zip from our own route (same deterministic build)
    const packetUrl = `${origin}/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
    const pr = await fetch(packetUrl, { method: "GET", cache: "no-store" });
    if (!pr.ok) {
      const t = await pr.text();
      throw new Error(`packet.zip failed: HTTP ${pr.status} ${t.slice(0, 160)}`);
    }
    const packetBuf = Buffer.from(await pr.arrayBuffer());

    const generatedAtIso = pr.headers.get("x-peakops-generatedat") || "2000-01-01T00:00:00.000Z";
    const fixedZipDate = new Date(generatedAtIso);
    const packetHash = pr.headers.get("x-peakops-packethash") || "";
    const packetZipSha = pr.headers.get("x-peakops-zip-sha256") || sha256Hex(packetBuf);

    const bundleManifest = {
      orgId,
      incidentId,
      generatedAt: generatedAtIso,
      packetHash,
      files: [
        { path: "packet.zip", bytes: packetBuf.length, sha256: packetZipSha },
        { path: "bundle_manifest.json", bytes: 0, sha256: "" },
      ],
    };

    const manifestText = JSON.stringify(bundleManifest, null, 2);
    bundleManifest.files[1].bytes = Buffer.byteLength(manifestText, "utf8");
    bundleManifest.files[1].sha256 = sha256Hex(manifestText);

    const zip = new JSZip();
    zip.file("packet.zip", packetBuf, { binary: true, date: fixedZipDate });
    zip.file("bundle_manifest.json", JSON.stringify(bundleManifest, null, 2), { date: fixedZipDate });

    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const zipSha256 = sha256Hex(buf);

    return new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="incident_${incidentId}_bundle.zip"`,
        "x-peakops-generatedat": generatedAtIso,
        "x-peakops-packethash": packetHash,
        "x-peakops-zip-sha256": zipSha256,
        "x-peakops-zip-size": String(buf.length),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS

echo "✅ wrote deterministic ZIP routes"

echo "🧹 clear Next cache"
rm -rf next-app/.next 2>/dev/null || true

echo "🚀 restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke PACKET ZIP (expect 200 + application/zip)"
curl -I -sS "http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST" | head -n 20
echo
echo "==> smoke BUNDLE ZIP (expect 200 + application/zip)"
curl -I -sS "http://127.0.0.1:3000/api/fn/downloadIncidentBundleZip?orgId=org_001&incidentId=inc_TEST" | head -n 20

echo
echo "✅ open bundle page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" || true

echo
echo "If anything is still failing:"
echo "  tail -n 120 .logs/next.log"
