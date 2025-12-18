import crypto from "crypto";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Deterministic JSON canonicalizer (sorts keys recursively)
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

export function sha256OfObject(obj) {
  const canonical = stableStringify(obj);
  return { canonical, hash: sha256Hex(canonical) };
}
