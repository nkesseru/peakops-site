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

  const generatedAt = new Date().toISOString();
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
    const generatedAtIso = (packetMeta?.exportedAt || "" + new Date().toISOString() + "") as string;
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
    ].join("");

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
    const computedPacketHash = sha256Hex(files["manifest.json"] + "" + files["hashes.json"]);
    const packetHash = packetMeta?.packetHash || computedPacketHash;

    // Zip (stable timestamps)
    const zip = new JSZip();
    for (const pth of Object.keys(files).sort()) {
      zip.file(pth, files[pth], { date: fixedZipDate });
    }

    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const zipSha256 = sha256Hex(buf);

    const res = new NextResponse(new Uint8Array(buf), {
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
