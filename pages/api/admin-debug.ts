import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminDb } from "../../lib/firebaseAdmin";

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const db = getAdminDb();
    const ref = db.collection("_health").doc("ping");
    await ref.set({ ts: Date.now() }, { merge: true });
    const snap = await ref.get();
    res.status(200).json({ ok: true, data: snap.data() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
