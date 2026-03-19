export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function isObj(v: any) { return v && typeof v === "object" && !Array.isArray(v); }

export function validateOe417V1(payload: any): ValidationResult {
  const errors: string[] = [];
  if (!isObj(payload)) return { ok: false, errors: ["payload must be an object"] };

  const reqStr = (path: string, v: any) => {
    if (typeof v !== "string" || !v.trim()) errors.push(`${path} must be a non-empty string`);
  };

  reqStr("filingType", payload.filingType);
  const ft = payload.filingType ? String(payload.filingType).toUpperCase() : "";
  if (ft !== "OE_417" && ft !== "OE-417") errors.push(`filingType must be "OE_417" (or "OE-417")`);

  reqStr("eventType", payload.eventType);
  reqStr("impact", payload.impact);
  reqStr("startTime", payload.startTime);
  reqStr("narrative", payload.narrative);

  // optional but useful
  if (payload.orgId != null) reqStr("orgId", payload.orgId);
  if (payload.incidentId != null) reqStr("incidentId", payload.incidentId);

  return errors.length ? { ok: false, errors } : { ok: true };
}
