function mustStr(v, name) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing ${name}`);
  return v.trim();
}

export async function submitOE417({ incidentId, orgId, filingType, payload, correlationId="", idempotencyKey="" }) {
  incidentId = mustStr(incidentId, "incidentId");
  orgId = mustStr(orgId, "orgId");
  filingType = mustStr(filingType, "filingType");

  const base = (process.env.OE417_ADAPTER_URL || "").trim();
  if (!base) throw Object.assign(new Error("OE417_ADAPTER_URL_NOT_SET"), { code: "CONFIG_ERROR" });

  const url = `${base.replace(/\/+$/, "")}/submit`;

  const headers = { "Content-Type": "application/json" };
  const tok = (process.env.OE417_ADAPTER_TOKEN || "").trim();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;

  const reqBody = {
    provider: "DOE",
    system: "OE_417",
    orgId,
    incidentId,
    filingType: "OE_417",
    payload: (payload && typeof payload === "object") ? payload : {},
    correlationId: String(correlationId || ""),
    idempotencyKey: String(idempotencyKey || ""),
  };

  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(reqBody) });
  const text = await r.text();
  let out;
  try { out = JSON.parse(text); }
  catch { out = { ok: false, error: "NON_JSON_RESPONSE", rawText: text }; }

  if (!r.ok || out?.ok !== true) {
    const err = new Error(out?.error || `OE417_HTTP_${r.status}`);
    err.code = out?.code || "OE417_ADAPTER_FAILED";
    err.httpStatus = r.status;
    err.adapterResponse = out;
    throw err;
  }

  return {
    ok: true,
    provider: "DOE",
    submissionMethod: out.submissionMethod || "AUTO",
    confirmationId: String(out.confirmationId || "").trim(),
    notes: out.notes || "",
    rawRequest: reqBody,
    rawResponse: out.rawResponse || out,
  };
}
