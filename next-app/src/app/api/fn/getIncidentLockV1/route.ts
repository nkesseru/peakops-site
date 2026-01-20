// AUTO-GENERATED (mega_finalize_incident_v1_FIXED)
import { NextResponse } from "next/server";

function json(ok: boolean, body: any, status = 200) {
  return NextResponse.json({ ok, ...body }, { status });
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

function firestoreBase() {
  const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // e.g. 127.0.0.1:8080
  return `http://${host}/v1`;
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

function readField(fields: any, key: string): any {
  const v = fields?.[key];
  if (!v) return null;
  return v.booleanValue ?? v.stringValue ?? v.integerValue ?? v.doubleValue ?? null;
}

export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const orgId = u.searchParams.get("orgId") || "";
    const incidentId = u.searchParams.get("incidentId") || "";
    if (!orgId) return json(false, { error: "orgId required" }, 400);
    if (!incidentId) return json(false, { error: "incidentId required" }, 400);

    const docUrl =
      `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;

    const r = await fetch(docUrl, { method: "GET" });
    const t = await r.text();
    let j: any = null;
    try { j = JSON.parse(t); } catch {}

    if (!r.ok) return json(false, { error: j?.error?.message || t || `HTTP ${r.status}` }, 404);

    const fields = j?.fields || {};
    const immutable = !!readField(fields, "immutable");
    const immutableAt = readField(fields, "immutableAt");
    const immutableBy = readField(fields, "immutableBy");
    const immutableReason = readField(fields, "immutableReason");

    return json(true, { orgId, incidentId, projectId: projectId(), immutable, immutableAt, immutableBy, immutableReason }, 200);
  } catch (e: any) {
    return json(false, { error: String(e?.message || e) }, 500);
  }
}

