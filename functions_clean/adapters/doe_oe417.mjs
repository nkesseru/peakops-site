const ADAPTER_VERSION = "v1";

function mustStr(v, name) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing ${name}`);
  return v.trim();
}

export async function submitOE417({
  incidentId,
  orgId,
  filingType,
  payload,
  correlationId,
  idempotencyKey,
  traceId,
} = {}) {
  incidentId = mustStr(incidentId, "incidentId");
  orgId = mustStr(orgId, "orgId");
  filingType = mustStr(filingType, "filingType"); // expected "OE_417"

  const base = (process.env.OE417_ADAPTER_URL || "").trim();
  if (!base) throw new Error("OE417_ADAPTER_URL not set (Cloud Run URL)");

  const url = `${base.replace(/\/+$/, "")}/submit`;

  const reqBody = {
    provider: "DOE",
    system: "OE_417",
    orgId,
    incidentId,
    filingType,
    payload: payload ?? {},
    correlationId: String(correlationId || ""),
    idempotencyKey: String(idempotencyKey || ""),
    traceId: String(traceId || ""),
    adapterVersion: ADAPTER_VERSION,
  };

  const headers = {
    "Content-Type": "application/json",
    ...(process.env.OE417_ADAPTER_TOKEN && String(process.env.OE417_ADAPTER_TOKEN).trim()
      ? { Authorization: `Bearer ${String(process.env.OE417_ADAPTER_TOKEN).trim()}` }
      : {}),
  };

  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  });

  const text = await r.text();
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    out = { ok: false, error: "Non-JSON response", raw: text };
  }

  if (!r.ok || out.ok !== true) {
    const msg = out?.error || `OE417_ADAPTER_HTTP_${r.status}`;
    const err = new Error(msg);
    err.code = out?.code || "OE417_ADAPTER_FAILED";
    err.httpStatus = r.status;
    err.adapterResponse = out;
    throw err;
  }

  return {
    ok: true,
    provider: out.provider || "DOE",
    submissionMethod: out.submissionMethod || "AUTO",
    confirmationId: String(out.confirmationId || "").trim(),
    notes: out.notes || "",
    correlationId: out.correlationId || "",
    traceId: out.traceId || "",
    adapterVersion: ADAPTER_VERSION,
    rawRequest: reqBody,
    rawResponse: out,
  };
}
