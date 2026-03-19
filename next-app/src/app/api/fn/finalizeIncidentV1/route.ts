// FINALIZE (deterministic rewrite) — seals incident as immutable in Firestore emulator via REST
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function json(ok: boolean, body: any, status = 200) {
  return NextResponse.json({ ok, ...body }, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

function firestoreBase() {
  // expects "127.0.0.1:8080"
  const host = mustEnv("FIRESTORE_EMULATOR_HOST");
  return `http://${host}/v1`;
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const orgId = String(body?.orgId || "");
    const incidentId = String(body?.incidentId || "");
    const immutableBy = String(body?.immutableBy || "ui");
    const immutableReason = String(body?.immutableReason || "");

    if (!orgId) return json(false, { error: "orgId required" }, 400);
    if (!incidentId) return json(false, { error: "incidentId required" }, 400);

    const nowIso = new Date().toISOString();

    const docUrl =
      `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;

    // 1) read first (idempotent)
    const gr = await fetch(docUrl, { method: "GET" });
    const gt = await gr.text();
    let gj: any = null;
    try { gj = JSON.parse(gt); } catch {}
    if (!gr.ok) return json(false, { error: gj?.error?.message || gt || `HTTP ${gr.status}` }, 404);

    const alreadyImmutable = !!gj?.fields?.immutable?.booleanValue;
    if (alreadyImmutable) {
      return json(true, {
        orgId,
        incidentId,
        projectId: projectId(),
        immutable: true,
        immutableAt: gj?.fields?.immutableAt?.stringValue || null,
        immutableBy: gj?.fields?.immutableBy?.stringValue || null,
        immutableReason: gj?.fields?.immutableReason?.stringValue || null,
        note: "already immutable",
      }, 200);
    }

    // 2) patch immutable fields
    const patchUrl =
      docUrl +
      `?updateMask.fieldPaths=immutable` +
      `&updateMask.fieldPaths=immutableAt` +
      `&updateMask.fieldPaths=immutableBy` +
      `&updateMask.fieldPaths=immutableReason`;

    const patchBody: any = {
      fields: {
        immutable: { booleanValue: true },
        immutableAt: { stringValue: nowIso },
        immutableBy: { stringValue: immutableBy },
        immutableReason: { stringValue: immutableReason || "" },
      },
    };

    const pr = await fetch(patchUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patchBody),
    });

    const pt = await pr.text();
    let pj: any = null;
    try { pj = JSON.parse(pt); } catch {}
    if (!pr.ok) return json(false, { error: pj?.error?.message || pt || `HTTP ${pr.status}` }, 500);

    return json(true, {
      orgId,
      incidentId,
      projectId: projectId(),
      immutable: true,
      immutableAt: nowIso,
      immutableBy,
      immutableReason: immutableReason || "",
    }, 200);
  } catch (e: any) {
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
