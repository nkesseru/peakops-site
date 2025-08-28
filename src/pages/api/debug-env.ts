import type { NextApiRequest, NextApiResponse } from "next";
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const raw = process.env.FIREBASE_PRIVATE_KEY || "";
  res.status(200).json({
    project: process.env.FIREBASE_PROJECT_ID || null,
    email: process.env.FIREBASE_CLIENT_EMAIL || null,
    hasKey: raw.length > 0,
    containsSlashN: raw.includes("\\n"),
    keyStart: raw.slice(0, 27),
    keyEnd: raw.slice(-27)
  });
}
