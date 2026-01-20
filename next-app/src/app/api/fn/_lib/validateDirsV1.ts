export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

function isObj(v: any) { return v && typeof v === "object" && !Array.isArray(v); }

export function validateDirsV1(payload: any): ValidationResult {
  const errors: string[] = [];
  if (!isObj(payload)) return { ok: false, errors: ["payload must be an object"] };

  const reqStr = (path: string, v: any) => {
    if (typeof v !== "string" || !v.trim()) errors.push(`${path} must be a non-empty string`);
  };
  const reqNum = (path: string, v: any) => {
    if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${path} must be a number`);
  };

  reqStr("filingType", payload.filingType);
  if (payload.filingType && String(payload.filingType).toUpperCase() !== "DIRS") {
    errors.push(`filingType must be "DIRS"`);
  }

  reqStr("outageType", payload.outageType);
  reqStr("startTime", payload.startTime);
  reqStr("narrative", payload.narrative);
  reqNum("affectedCount", payload.affectedCount);

  if (!isObj(payload.location)) {
    errors.push("location must be an object");
  } else {
    reqStr("location.state", payload.location.state);
    reqStr("location.county", payload.location.county);
  }

  // optional but useful
  if (payload.orgId != null) reqStr("orgId", payload.orgId);
  if (payload.incidentId != null) reqStr("incidentId", payload.incidentId);

  return errors.length ? { ok: false, errors } : { ok: true };
}
