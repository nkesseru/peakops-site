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
  const rest = process.env.FIRESTORE_EMULATOR_REST;
  if (rest) return rest.replace(/\/+$/, "");
  const host = mustEnv("FIRESTORE_EMULATOR_HOST"); // 127.0.0.1:8080
  return `http://${host}/v1`;
}

function projectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "peakops-pilot";
}

function newId() {
  // inc_YYYYMMDD_HHMMSS_rand
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "_" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());
  const rand = Math.random().toString(16).slice(2, 8);
  return `inc_${stamp}_${rand}`;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const orgId = String(body?.orgId || "");
    const title = String(body?.title || "New Incident");
    const startTime = String(body?.startTime || new Date().toISOString());

    if (!orgId) return json(false, { error: "orgId required" }, 400);

    const incidentId = newId();
    const docUrl =
      `${firestoreBase()}/projects/${projectId()}/databases/(default)/documents/incidents/${encodeURIComponent(incidentId)}`;

    const patchUrl =
      docUrl +
      `?updateMask.fieldPaths=orgId&updateMask.fieldPaths=title&updateMask.fieldPaths=startTime`;

    const payload = {
      fields: {
        orgId: { stringValue: orgId },
        title: { stringValue: title },
        startTime: { stringValue: startTime },
      },
    };

    const r = await fetch(patchUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const t = await r.text();
    let j: any = null;
    try { j = JSON.parse(t); } catch {}

    if (!r.ok) return json(false, { error: j?.error?.message || t || `HTTP ${r.status}` }, 500);

    return json(true, { orgId, incidentId, title, startTime }, 200);
  } catch (e: any) {
    return json(false, { error: String(e?.message || e) }, 500);
  }
}
