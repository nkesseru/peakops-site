import { NextResponse } from "next/server";
import { proxyPOST } from "../_lib/fnProxy";

export const runtime = "nodejs";

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}
function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}
function firestoreBase() {
  const host = mustEnv("FIRESTORE_EMULATOR_HOST");
  return `http://${host}/v1`;
}
function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}
async function isImmutable(incidentId: string): Promise<boolean> {
  const url =
    `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) return false;
  const j: any = await r.json().catch(() => null);
  return !!j?.fields?.immutable?.booleanValue;
}
async function guardOr409FromBody(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  const incidentId = String(body?.incidentId || "");
  if (!incidentId) return { blocked: null as any, body };
  const imm = await isImmutable(incidentId);
  if (imm) return { blocked: json(409, { ok: false, error: "IMMUTABLE: Incident is finalized" }), body };
  return { blocked: null as any, body };
}

export async function POST(req: Request) {
  const { blocked, body } = await guardOr409FromBody(req);
  if (blocked) return blocked;

  const url = new URL(req.url);
  const fwd = new Request(url.toString(), {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(body),
  });

  return proxyPOST(fwd, "createEvidenceUploadUrlV1");
}
