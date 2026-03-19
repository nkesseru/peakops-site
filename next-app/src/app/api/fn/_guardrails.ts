export function json(ok: boolean, body: any, status = 200) {
  return new Response(JSON.stringify({ ok, ...body }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envOrThrow(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

export function firestoreDocUrl(projectId: string, path: string) {
  const base = envOrThrow("FIRESTORE_EMULATOR_REST").replace(/\/+$/, "");
  return `${base}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path}`;
}

export async function readIncidentLockOrNull(projectId: string, incidentId: string) {
  const docUrl = firestoreDocUrl(projectId, `incidents/${encodeURIComponent(incidentId)}`);
  const r = await fetch(docUrl, { method: "GET" });
  const t = await r.text();
  let j: any = null;
  try { j = JSON.parse(t); } catch { /* ignore */ }
  if (!r.ok) return null;

  const f = j?.fields || {};
  const immutable = !!f?.immutable?.booleanValue;
  const immutableAt = f?.immutableAt?.stringValue || null;
  const immutableBy = f?.immutableBy?.stringValue || null;
  const immutableReason = f?.immutableReason?.stringValue || null;

  return { immutable, immutableAt, immutableBy, immutableReason };
}

export async function assertMutableOrThrow(projectId: string, incidentId: string) {
  const lock = await readIncidentLockOrNull(projectId, incidentId);
  if (lock?.immutable) {
    const msg = `Incident is immutable (sealed). immutableAt=${lock.immutableAt || "?"} immutableBy=${lock.immutableBy || "?"}`;
    const err: any = new Error(msg);
    err.code = "IMMUTABLE";
    throw err;
  }
}
