import { NextResponse } from "next/server";

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

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId") || "";
    const incidentId = url.searchParams.get("incidentId") || "";
    if (!orgId || !incidentId) return json({ ok: false, error: "Missing orgId or incidentId" }, 400);

    const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // e.g. 127.0.0.1:8080
    const base = `http://${host}/v1/projects/peakops-pilot/databases/(default)/documents`;
    const docPath = `orgs/${encodeURIComponent(orgId)}/incidents/${encodeURIComponent(incidentId)}/packetMeta/zipVerification`;

    const r = await fetch(`${base}/${docPath}`);
    if (r.status === 404) {
      return json({ ok: true, orgId, incidentId, projectId: "peakops-pilot", docOrg: orgId, zipMeta: null }, 200);
    }
    const j = await r.json().catch(() => null);
    const f = j?.fields || null;
    const sv = (x: any) => x?.stringValue ?? null;
    const iv = (x: any) => (x?.integerValue != null ? Number(x.integerValue) : null);

    const zipMeta = f
      ? {
          zipSha256: sv(f.zipSha256),
          zipSize: iv(f.zipSize),
          zipGeneratedAt: sv(f.zipGeneratedAt),
          verifiedAt: sv(f.verifiedAt),
          verifiedBy: sv(f.verifiedBy),
        }
      : null;

    return json({ ok: true, orgId, incidentId, projectId: "peakops-pilot", docOrg: orgId, zipMeta }, 200);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
