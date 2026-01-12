#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak
cp "$FILE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

cat > "$FILE" <<'TS'
import { NextResponse } from "next/server";
import JSZip from "jszip";
import crypto from "crypto";

export const runtime = "nodejs";

type Json = any;

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fetchJson(url: string): Promise<{ ok: true; json: Json } | { ok: false; err: string; sample?: string }> {
  const r = await fetch(url, { method: "GET" });
  const text = await r.text();
  if (!text || !text.trim()) return { ok: false, err: `empty body (HTTP ${r.status})` };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, err: `non-JSON (HTTP ${r.status}): ${String(e?.message || e)}`, sample: text.slice(0, 220) };
  }
}

function asString(v: any): string {
  return typeof v === "string" ? v : String(v ?? "");
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    const contractId = url.searchParams.get("contractId") || "";

    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
    }

    const origin = url.origin;

    // Pull data via existing Next proxy routes (keeps it env-safe)
    const workflowR = await fetchJson(`${origin}/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
    const timelineR = await fetchJson(`${origin}/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`);

    // Optional: contract + payloads
    const contractR = contractId
      ? await fetchJson(`${origin}/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`)
      : null;

    const payloadsR = contractId
      ? await fetchJson(`${origin}/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=200`)
      : null;

    const nowIso = new Date().toISOString();

    // Build logical file list first
    const files: { path: string; json?: any; text?: string }[] = [];

    files.push({
      path: "README.txt",
      text:
        `PeakOps Immutable Incident Artifact\n` +
        `orgId=${orgId}\nincidentId=${incidentId}\n` +
        (contractId ? `contractId=${contractId}\n` : "") +
        `generatedAt=${nowIso}\n`,
    });

    files.push({
      path: "packet_meta.json",
      json: {
        orgId,
        incidentId,
        contractId: contractId || null,
        generatedAt: nowIso,
        sources: {
          workflow: workflowR.ok ? "ok" : { error: workflowR.err, sample: workflowR.sample },
          timeline: timelineR.ok ? "ok" : { error: timelineR.err, sample: timelineR.sample },
          contract: contractR ? (contractR.ok ? "ok" : { error: contractR.err, sample: contractR.sample }) : "n/a",
          payloads: payloadsR ? (payloadsR.ok ? "ok" : { error: payloadsR.err, sample: payloadsR.sample }) : "n/a",
        },
      },
    });

    if (workflowR.ok) files.push({ path: "workflow.json", json: workflowR.json });
    if (timelineR.ok) files.push({ path: "timeline/events.json", json: timelineR.json });

    if (contractR?.ok) files.push({ path: "contract/contract.json", json: contractR.json });

    if (payloadsR?.ok) {
      const docs = Array.isArray((payloadsR.json as any)?.docs) ? (payloadsR.json as any).docs : [];
      for (const d of docs) {
        const id = asString(d?.id || "payload");
        files.push({ path: `filings/${id}.json`, json: d });
      }
    }

    // Turn files into zip + hashes
    const zip = new JSZip();
    const hashes: Record<string, string> = {};

    for (const f of files) {
      const buf =
        f.text != null
          ? Buffer.from(f.text, "utf8")
          : Buffer.from(JSON.stringify(f.json ?? null, null, 2), "utf8");

      hashes[f.path] = sha256(buf);
      zip.file(f.path, buf);
    }

    const manifest = {
      orgId,
      incidentId,
      contractId: contractId || null,
      generatedAt: nowIso,
      files: Object.keys(hashes).sort(),
    };

    zip.file("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
    zip.file("hashes.json", Buffer.from(JSON.stringify(hashes, null, 2), "utf8"));

    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const filename = `incident_${incidentId}_packet.zip`;

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS

echo "✅ wrote: $FILE"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke: download route (should be 200 + application/zip)"
URL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123"
curl -fsSI "$URL" | head -n 20

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
