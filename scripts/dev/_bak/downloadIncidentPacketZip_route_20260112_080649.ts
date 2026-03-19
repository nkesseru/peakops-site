import { NextResponse } from "next/server";
import JSZip from "jszip";
import crypto from "crypto";

export const runtime = "nodejs";

type AnyObj = Record<string, any>;

function sha256(buf: Uint8Array) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: AnyObj = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}

function stableJson(value: any) {
  return JSON.stringify(stable(value), null, 2);
}

async function safeFetchJson(url: string): Promise<{ ok: true; v: any } | { ok: false; err: string; status?: number; sample?: string }> {
  try {
    const r = await fetch(url, { method: "GET", cache: "no-store" });
    const text = await r.text();
    if (!text || !text.trim()) return { ok: false, err: "empty body", status: r.status };
    try {
      const v = JSON.parse(text);
      return { ok: true, v };
    } catch (e: any) {
      return { ok: false, err: String(e?.message || e), status: r.status, sample: text.slice(0, 200) };
    }
  } catch (e: any) {
    return { ok: false, err: String(e?.message || e) };
  }
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

    // 1) Pull canonical packet meta (your existing function that also “generates”)
    const exportUrl =
      `${url.origin}/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}` +
      (contractId ? `&contractId=${encodeURIComponent(contractId)}` : "");

    const exportResp = await safeFetchJson(exportUrl);
    if (!exportResp.ok) {
      return NextResponse.json(
        { ok: false, error: `exportIncidentPacketV1 failed (${exportResp.status ?? "?"}): ${exportResp.err}`, sample: exportResp.sample },
        { status: 502 }
      );
    }
    const exportJson = exportResp.v || {};
    if (exportJson?.ok === false) {
      return NextResponse.json({ ok: false, error: String(exportJson?.error || "exportIncidentPacketV1 failed") }, { status: 500 });
    }

    const packetMetaFromFn = exportJson.packetMeta || null;

    // 2) Pull workflow + timeline (best effort; don’t fail the ZIP if missing)
    const wfUrl =
      `${url.origin}/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}`;
    const tlUrl =
      `${url.origin}/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}` +
      `&limit=500`;

    const [wfResp, tlResp] = await Promise.all([safeFetchJson(wfUrl), safeFetchJson(tlUrl)]);
    const workflow = wfResp.ok ? wfResp.v : { ok: false, error: wfResp.err };
    const timeline = tlResp.ok ? tlResp.v : { ok: false, error: tlResp.err };

    // 3) Optional: contract snapshot
    let contractSnap: any = null;
    if (contractId) {
      const cUrl =
        `${url.origin}/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}` +
        `&contractId=${encodeURIComponent(contractId)}`;
      const cResp = await safeFetchJson(cUrl);
      if (cResp.ok && cResp.v?.ok !== false) contractSnap = cResp.v;
      else contractSnap = { ok: false, error: cResp.ok ? (cResp.v?.error || "contract fetch failed") : cResp.err };
    }

    // 4) Filings folder stub (real filings will come later)
    const filingsStub = {
      ok: true,
      orgId,
      incidentId,
      contractId: contractId || null,
      note: "Stub. Real filings will be materialized into filings/*.json (DIRS/OE-417/NORS/SAR/BABA).",
      expected: ["DIRS", "OE_417", "NORS", "SAR", "BABA"],
      generatedAt: new Date().toISOString(),
    };

    // 5) Build ZIP with deterministic file ordering + hashes
    const zip = new JSZip();

    // File map (path -> bytes)
    const files: { path: string; bytes: Uint8Array }[] = [];

    const pushText = (path: string, text: string) => {
      const bytes = Buffer.from(text, "utf8");
      files.push({ path, bytes });
    };

    pushText("README.txt", `PeakOps Incident Bundle\norgId=${orgId}\nincidentId=${incidentId}\ncontractId=${contractId || ""}\n`);
    pushText("packet_meta.json", stableJson({
      orgId,
      incidentId,
      contractId: contractId || null,
      generatedAt: new Date().toISOString(),
      packetMeta: packetMetaFromFn,
    }));
    pushText("workflow.json", stableJson(workflow));
    pushText("timeline/events.json", stableJson(timeline));

    if (contractId) {
      pushText("contract/contract.json", stableJson(contractSnap));
    }

    pushText("filings/README.txt", "Filings are stubbed. This folder will contain DIRS/OE-417/NORS/SAR/BABA payload JSON.");
    pushText("filings/_stub.json", stableJson(filingsStub));

    // Write files into zip (stable order)
    files.sort((a, b) => a.path.localeCompare(b.path));
    for (const f of files) zip.file(f.path, f.bytes);

    // hashes.json (sha256 per file)
    const hashes: Record<string, string> = {};
    for (const f of files) hashes[f.path] = sha256(f.bytes);

    const manifest = {
      orgId,
      incidentId,
      contractId: contractId || null,
      generatedAt: new Date().toISOString(),
      files: files.map((f) => f.path),
    };

    zip.file("manifest.json", Buffer.from(stableJson(manifest), "utf8"));
    zip.file("hashes.json", Buffer.from(stableJson(hashes), "utf8"));

    // Generate zip bytes + zip hash
    const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const zipBytesSha256 = sha256(zipBytes);

    // Update packet_meta.json to include zipBytesSha256 + sizeBytes (without changing file hashes order)
    // (We keep the earlier packet_meta.json as-is for now; the canonical integrity is hashes.json + zipBytesSha256 in response headers.)
    const filename = `incident_${incidentId}_packet.zip`;

    return new NextResponse(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-PeakOps-Zip-SHA256": zipBytesSha256,
        "X-PeakOps-Zip-Size": String(zipBytes.byteLength),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
