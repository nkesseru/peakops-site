import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminDb } from "../../lib/firebaseAdmin";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const db = getAdminDb();
    const qs = await db.collection("jobs").limit(1).get();
    res.status(200).json({ ok: true, jobsSampleCount: qs.size });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
