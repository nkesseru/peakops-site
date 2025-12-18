import crypto from "crypto";
import { stableStringify } from "./stableStringify";

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sha256OfObject(obj: any): { hash: string; canonical: string } {
  const canonical = stableStringify(obj);
  const hash = sha256Hex(canonical);
  return { hash, canonical };
}
