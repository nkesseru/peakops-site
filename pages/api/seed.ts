import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminDb } from "../../lib/firebaseAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  try {
    const db = getAdminDb();
    await db.collection("jobs").doc("WO-TEST-200").set({
      orgId: "butler_pilot",
      wo: { id: "WO-TEST-200", carrierId: "ATT", scope: "LTE upgrade" },
      status: "scheduled",
      assignedTechs: ["tech_177"],
      preflight: { dispatcherDone: false, techDone: false },
      compliance: { progress: { ok: 0, required: 12 }, ready: false },
      window: { start: new Date("2025-10-05T15:00:00Z"), end: new Date("2025-10-05T17:00:00Z") }
    }, { merge: true });
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("seed error", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "seed-failed" });
  }
}
