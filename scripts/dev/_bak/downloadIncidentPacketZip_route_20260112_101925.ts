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

const hashes: Record<string, string> = {};
const manifestFiles: { path: string; sha256: string; sizeBytes: number }[] = [];

for (const f of files) {
  const h = sha256(f.bytes);
  hashes[f.path] = h;
  manifestFiles.push({ path: f.path, sha256: h, sizeBytes: f.bytes.byteLength });
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
