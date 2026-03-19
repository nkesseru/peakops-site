
import { NextResponse } from "next/server";
import { proxyGET, proxyPOST } from "../_lib/fnProxy";

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
  const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // e.g. 127.0.0.1:8080
  return `http://${host}/v1`;
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

async function isImmutable(incidentId: string): Promise<boolean> {
  const url = `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) return false; // fail-open in dev
  const j: any = await r.json().catch(() => null);
  return !!j?.fields?.immutable?.booleanValue;
}

function getQ(req: Request) {
  const u = new URL(req.url);
  return u.searchParams;
}

async function guardOr409(req: Request, allowForce: boolean) {
  const q = getQ(req);
  const incidentId = String(q.get("incidentId") || "");
  const force = (q.get("force") || "") === "1";
  if (!incidentId) return null; // let underlying handler return its own 400s

  // If immutable and not forced (or force not allowed), block.
  const imm = await isImmutable(incidentId);
  if (imm) {
    if (allowForce && force) return null;
    return json(409, { ok: false, error: "IMMUTABLE: Incident is finalized" });
  }
  return null;
}

export async function POST(req: Request) {
  const blocked = await guardOr409(req, false);
  if (blocked) return blocked;
  return proxyPOST(req, "generateTimelineV1");
}

