/**
 * FCC DIRS Adapter client (PeakOps -> Cloud Run dirs-adapter)
 * Env:
 *  - DIRS_ADAPTER_URL   (required) e.g. https://dirs-adapter-xxxx-uc.a.run.app  OR http://127.0.0.1:8080
 *  - DIRS_ADAPTER_TOKEN (optional) bearer token if adapter auth is enabled
 */
function mustStr(v, name) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing ${name}`);
  return v.trim();
}

export async function submitDIRS({
  incidentId,
  orgId,
  filingType = "DIRS",
  payload = {},
  correlationId = "",
  idempotencyKey = "",
}) {
  incidentId = mustStr(incidentId, "incidentId");
  orgId = mustStr(orgId, "orgId");
  filingType = mustStr(filingType, "filingType");

  const base = (process.env.DIRS_ADAPTER_URL || "").trim();
  if (!base) throw new Error("DIRS_ADAPTER_URL not set");

  const url = `${base.replace(/\/+$/,"")}/submit`;

  const reqBody = {
    orgId,
    incidentId,
    filingType,
    payload: (payload && typeof payload === "object") ? payload : {},
    correlationId: correlationId || "",
    idempotencyKey: idempotencyKey || "",
  };

  const headers = { "Content-Type": "application/json" };
  const tok = (process.env.DIRS_ADAPTER_TOKEN || "").trim();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;

  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqBody) });
  const text = await r.text();
  let out;
  try { out = JSON.parse(text); } catch { out = { ok: false, error: "NON_JSON_RESPONSE", raw: text }; }

  if (!r.ok || out?.ok !== true) {
    const err = new Error(out?.error || `DIRS_ADAPTER_HTTP_${r.status}`);
    err.code = out?.code || "DIRS_ADAPTER_FAILED";
    err.httpStatus = r.status;
    err.adapterResponse = out;
    throw err;
  }

  return {
    ok: true,
    provider: out.provider || "FCC",
    submissionMethod: out.submissionMethod || "AUTO",
    confirmationId: String(out.confirmationId || "").trim(),
    notes: out.notes || "",
    correlationId: out.correlationId || "",
    rawRequest: reqBody,
    rawResponse: out,
  };
}
