import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminDb } from "../../../lib/firebaseAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  try {
    const { jobId, techId } = req.body || {};
    if (!jobId || !techId) return res.status(400).json({ ok: false, error: "Missing jobId/techId" });

    const db = getAdminDb();
    const jobRef = db.collection("jobs").doc(jobId);
    await jobRef.set({ assignedTechs: [techId] }, { merge: true });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("assign error", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "assign-failed" });
  }
}
