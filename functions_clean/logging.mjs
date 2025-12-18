export function nowIso() {
  return new Date().toISOString();
}

export function requireStr(v, name) {
  if (!v || typeof v !== "string") throw new Error(`Missing/invalid ${name}`);
  return v;
}
