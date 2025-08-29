import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminDb } from "../../lib/firebaseAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    const db = getAdminDb();
    // ... write a test doc or whatever your seed does ...
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("seed error", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "seed-failed" });
  }
}
