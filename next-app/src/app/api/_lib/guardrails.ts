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
  const host = mustEnv("FIRESTORE_EMULATOR_HOST");
  return `http://${host}/v1`;
}
function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

export async function assertImmutableOrThrow(req: Request, orgId: string, incidentId: string) {
  const u = new URL(req.url);
  const force = u.searchParams.get("force") === "1";
  if (force) return { ok: true, force: true };

  const docUrl =
    `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;

  const r = await fetch(docUrl, { method: "GET" });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch {}

  if (!r.ok) throw new Error(j?.error?.message || t || `HTTP ${r.status}`);

  const immutable = !!j?.fields?.immutable?.booleanValue;
  if (immutable) {
    throw new Error("IMMUTABLE: incident is finalized (use force=1 for admin override)");
  }
  return { ok: true, force: false };
}

export function immutableReject(e: any) {
  const msg = String(e?.message || e);
  if (msg.startsWith("IMMUTABLE:")) return json(false, { error: msg }, 409);
  return null;
}
