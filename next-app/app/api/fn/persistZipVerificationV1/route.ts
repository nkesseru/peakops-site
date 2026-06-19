import { NextResponse } from "next/server";
import { requireOrgAccess } from "../../../../lib/verifyAuth";

export const runtime = "nodejs";

function json(v: any, status = 200) {
  return new NextResponse(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Firestore emulator not configured (${name} missing)`);
  return v;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const orgId = String(body?.orgId || "");
    const incidentId = String(body?.incidentId || "");
    const zipSha256 = String(body?.zipSha256 || "");
    const zipSize = Number(body?.zipSize || 0) || 0;
    const zipGeneratedAt = String(body?.zipGeneratedAt || "");
    const verifiedAt = String(body?.verifiedAt || new Date().toISOString());

    if (!incidentId || !zipSha256) return json({ ok: false, error: "Missing incidentId/zipSha256" }, 400);

    // Phase 3 enforcement: verify token + org membership before any
    // Firestore I/O. Identity (verifiedBy) is server-derived from the
    // verified token; client-supplied verifiedBy is ignored.
    let authCtx;
    try {
      authCtx = await requireOrgAccess(req, orgId);
    } catch (e: any) {
      const status = Number(e?.status || 401);
      return json({ ok: false, error: String(e?.message || "unauthorized") }, status);
    }
    console.log("[persistZipVerificationV1] org-authenticated", {
      uid: authCtx.uid,
      email: authCtx.email,
      orgId: authCtx.orgId,
      role: authCtx.role,
    });
    const verifiedBy = authCtx.uid;

    const host = mustEnv("FIRESTORE_EMULATOR_HOST");
    const base = `http://${host}/v1/projects/peakops-pilot/databases/(default)/documents`;
    const docPath = `orgs/${encodeURIComponent(orgId)}/incidents/${encodeURIComponent(incidentId)}/packetMeta/zipVerification`;

    const payload = {
      fields: {
        zipSha256: { stringValue: zipSha256 },
        zipSize: { integerValue: String(Math.max(0, Math.floor(zipSize))) },
        zipGeneratedAt: { stringValue: zipGeneratedAt || "" },
        verifiedAt: { stringValue: verifiedAt },
        verifiedBy: { stringValue: verifiedBy },
      },
    };

    const r = await fetch(`${base}/${docPath}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const j = await r.json().catch(() => null);
    if (!r.ok) return json({ ok: false, error: j?.error?.message || `Firestore write failed (HTTP ${r.status})`, raw: j }, 500);

    return json({ ok: true, orgId, incidentId, zipMeta: { zipSha256, zipSize, zipGeneratedAt, verifiedAt, verifiedBy } }, 200);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
