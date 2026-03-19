export function nowIso() {
  return new Date().toISOString();
}

export function requireStr(v, name) {
  if (!v || typeof v !== "string") throw new Error(`Missing/invalid ${name}`);
  return v;
}

export function optionalStr(v) {
  return (typeof v === "string" && v.trim()) ? v.trim() : null;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
