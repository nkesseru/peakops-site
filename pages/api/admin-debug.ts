import type { NextApiRequest, NextApiResponse } from "next";

// Rebuild PEM the same way your admin init does
function buildPem(): string {
  const b64 = process.env.FIREBASE_PRIVATE_KEY_BASE64?.trim();
  if (b64) {
    try { return Buffer.from(b64, "base64").toString("utf8"); } catch {}
  }
  const raw = process.env.FIREBASE_PRIVATE_KEY || "";
  const withoutQuotes = raw.replace(/^"+|"+$/g, "");
  return withoutQuotes.replace(/\\n/g, "\n");
}

export default function handler(_: NextApiRequest, res: NextApiResponse) {
  const pem = buildPem();
  res.status(200).json({
    hasB64: !!process.env.FIREBASE_PRIVATE_KEY_BASE64,
    hasRaw: !!process.env.FIREBASE_PRIVATE_KEY,
    begins: pem.startsWith("-----BEGIN PRIVATE KEY-----"),
    ends: pem.trim().endsWith("-----END PRIVATE KEY-----"),
    length: pem.length
  });
}
