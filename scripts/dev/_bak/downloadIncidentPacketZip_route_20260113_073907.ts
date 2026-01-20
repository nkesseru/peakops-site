import { NextResponse } from "next/server";
import { validateDirsV1 } from "../_lib/validateDirsV1";
import { validateOe417V1 } from "../_lib/validateOe417V1";
import JSZip from "jszip";
import crypto from "crypto";

export const runtime = "nodejs";

function sha256(buf: Uint8Array | Buffer): string {
  return crypto.createHash("sha256").update(Buffer.from(buf)).digest("hex");
}
function utf8(s: string): Uint8Array {
  return Buffer.from(s, "utf8");
}

type FileItem = { path: string; bytes: Uint8Array };

async function safeText(url: string) {
  const r = await fetch(url, { method: "GET" });
  const t = await r.text();
  return { r, t };
}
function safeJson(text: string): { ok: true; v: any } | { ok: false; err: string } {
  try { return { ok: true, v: JSON.parse(text) }; }
  catch (e: any) { return { ok: false, err: String(e?.message || e) }; }
}

function stubPayload(type: string, schema: string, nowIso: string) {
  return {
    ok: true,
    stub: true,
    type,
    schemaVersion: schema,
    generatedAt: nowIso,
    payload: (__filingsByType[String(spec.type || spec.id).toUpperCase()]?.payload || { "_placeholder":"INIT" }),
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    

/*__REAL_INCIDENT_FILINGS_V2__*/
async function fetchIncidentFilings(orgId: string, incidentId: string): Promise<Record<string, any>> {
  try {
    const base =
      (process.env.FN_BASE || process.env.NEXT_PUBLIC_FN_BASE || "").trim() ||
      "http://127.0.0.1:5001/peakops-pilot/us-central1";

    const url = `${base}/getIncidentBundleV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
    const r = await fetch(url, { method: "GET" });
    const j = await r.json().catch(() => null);

    const filings = Array.isArray(j?.filings) ? j.filings : [];
    const out: Record<string, any> = {};
    for (const f of filings) {
      const t = String(f?.type || f?.id || "").toUpperCase();
      if (!t) continue;
      out[t] = f;
    }
    return out;
  } catch {
    return {};
  }
}

const contractId = url.searchParams.get("contractId") || "";

    if (!orgId || !incidentId) {
      return NextResponse.json({ ok: false, error: "Missing orgId/incidentId" }, { status: 400 });
    }

    const origin = url.origin;
    const nowIso = new Date().toISOString();

    const files: FileItem[] = [];

    // --- README ---
    files.push({
      path: "README.txt",
      bytes: utf8(
        [
          "PeakOps — Immutable Incident Artifact (v1)",
          "",
          `orgId: ${orgId}`,
          `incidentId: ${incidentId}`,
          `generatedAt: ${nowIso}`,
          "",
          "Contents:",
          "- packet_meta.json",
          "- manifest.json",
          "- hashes.json",
          "- workflow.json",
          "- timeline/events.json",
          "- contract/contract.json (stub unless wired)",
          "- filings/* (REAL if incident has filings payloads, else stub)",
        ].join("\n")
      ),
    });

    // --- workflow.json ---
    {
      const wfUrl = `${origin}/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const { r, t } = await safeText(wfUrl);
      const p = safeJson(t);
      files.push({
        path: "workflow.json",
        bytes: utf8(
          JSON.stringify(
            p.ok ? p.v : { ok: false, error: `non-json: ${p.err}`, status: r.status, sample: (t || "").slice(0, 160) },
            null,
            2
          )
        ),
      });
    }

    // --- timeline/events.json ---
    {
      const tlUrl = `${origin}/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`;
      const { r, t } = await safeText(tlUrl);
      const p = safeJson(t);
      files.push({
        path: "timeline/events.json",
        bytes: utf8(
          JSON.stringify(
            p.ok ? p.v : { ok: false, error: `non-json: ${p.err}`, status: r.status, sample: (t || "").slice(0, 160) },
            null,
            2
          )
        ),
      });
    }

    // --- contract snapshot (still stub for incident path) ---
    files.push({
      path: "contract/contract.json",
      bytes: utf8(
        JSON.stringify(
          {
            ok: true,
            stub: true,
            note: "Contract snapshot for incident packets not wired yet (contractId param optional).",
            contractId: contractId || null,
            snapshotAt: nowIso,
          },
          null,
          2
        )
      ),
    });

    // --- REAL filings from incident bundle ---
    // We expect getIncidentBundle to return { ok:true, incident, filings:[...] } (your existing bundle endpoint).
    let filingsFromIncident: any[] = [];
    {
      const bUrl = `${origin}/api/fn/getIncidentBundleV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const { r, t } = await safeText(bUrl);
      const p = safeJson(t);

      if (p.ok && p.v?.ok && Array.isArray(p.v?.filings)) {
        filingsFromIncident = p.v.filings;
      } else {
        // keep a diagnostic note
        files.push({
          path: "filings/_bundle_error.json",
          bytes: utf8(
            JSON.stringify(
              {
                ok: false,
                error: "Could not load incident bundle filings; using stub filings instead.",
                status: r.status,
                parsedOk: p.ok,
                sample: (t || "").slice(0, 220),
              },
              null,
              2
            )
          ),
        });
      }
    }

    // Normalize + write filings
    // Each filings doc usually looks like: { type or filingType, payload, status, updatedAt, ... }
    const wanted = [
      { type: "DIRS", file: "filings/dirs.json", schema: "dirs.v1" },
      { type: "OE_417", file: "filings/oe417.json", schema: "oe_417.v1" },
      { type: "NORS", file: "filings/nors.json", schema: "nors.v1" },
      { type: "SAR", file: "filings/sar.json", schema: "sar.v1" },
      { type: "BABA", file: "filings/baba.json", schema: "baba.v1" },
    ];

    const index: any = {
      ok: true,
      generatedAt: nowIso,
      orgId,
      incidentId,
      source: "incident_bundle",
      filings: [] as any[],
    };

    function pickType(d: any) {
      const t = d?.type || d?.filingType || d?.filing_type;
      return String(t || "").toUpperCase();
      // OE-417 validation (v1)
      try {
        const v = validateOe417V1((payload && payload.payload) ? payload.payload : (payload || {}));
        files.push({
          path: "filings/oe417.validation.json",
          bytes: utf8(JSON.stringify({
            ok: v.ok,
            schemaVersion: "oe_417.v1",
            errors: v.errors,
            validatedAt: nowIso
          }, null, 2))
        });
      } catch (e) {
        files.push({
          path: "filings/oe417.validation.json",
          bytes: utf8(JSON.stringify({
            ok: false,
            schemaVersion: "oe_417.v1",
            errors: [String(e)],
            validatedAt: nowIso
          }, null, 2))
        });
      }

      // DIRS validation (v1)
      try {
        const v = validateDirsV1((payload && payload.payload) ? payload.payload : (payload || {}));
        files.push({
          path: "filings/dirs.validation.json",
          bytes: utf8(JSON.stringify({
            ok: v.ok,
            schemaVersion: "dirs.v1",
            errors: v.errors,
            validatedAt: nowIso
          }, null, 2))
        });
      } catch (e) {
        files.push({
          path: "filings/dirs.validation.json",
          bytes: utf8(JSON.stringify({
            ok: false,
            schemaVersion: "dirs.v1",
            errors: [String(e)],
            validatedAt: nowIso
          }, null, 2))
        });
      }

    }

    for (const w of wanted) {
      const found = filingsFromIncident.find((d) => pickType(d) === w.type);
      const payload = found?.payload ?? found ?? null;

      const doc = found
        ? {
            ok: true,
            source: "incident_bundle",
            orgId,
            incidentId,
            type: w.type,
            schemaVersion: found?.payload?.meta?.schemaVersion || found?.schemaVersion || w.schema,
            status: found?.status || "UNKNOWN",
            updatedAt: found?.updatedAt || null,
            payload,
          }
        : stubPayload(w.type, w.schema, nowIso);

      index.filings.push({
        type: w.type,
        file: w.file,
        status: doc?.status || "STUB",
        schemaVersion: doc?.schemaVersion || w.schema,
        present: !!found,
      });

      files.push({ path: w.file, bytes: utf8(JSON.stringify(doc, null, 2)) });
    }

    files.push({ path: "filings/index.json", bytes: utf8(JSON.stringify(index, null, 2)) });

    // --- packet_meta + manifest + hashes ---
    // packet_meta should be in the base set so it appears in manifest/hashes.
    const packetMetaBase = {
      orgId,
      incidentId,
      contractId: contractId || null,
      generatedAt: nowIso,
      packetHash: "",
      fileCount: 0,
    };
    files.push({ path: "packet_meta.json", bytes: utf8(JSON.stringify(packetMetaBase, null, 2)) });

    const hashes: Record<string, string> = {};
    const manifest: { path: string; sha256: string; sizeBytes: number }[] = [];

    for (const f of files) {
      const h = sha256(f.bytes);
      hashes[f.path] = h;
      manifest.push({ path: f.path, sha256: h, sizeBytes: f.bytes.byteLength });
    }

    const packetHash = sha256(utf8(JSON.stringify(hashes, null, 2)));

    const packetMeta = {
      orgId,
      incidentId,
      contractId: contractId || null,
      generatedAt: nowIso,
      packetHash,
      fileCount: files.length + 2,
      note: "hashes.json excludes itself; manifest.json excludes itself.",
    };

    // replace packet_meta.json content
    for (let i = 0; i < files.length; i++) {
      if (files[i].path === "packet_meta.json") {
        files[i] = { path: "packet_meta.json", bytes: utf8(JSON.stringify(packetMeta, null, 2)) };
        break;
      }
    }

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
