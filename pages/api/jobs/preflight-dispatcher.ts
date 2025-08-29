import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminDb } from "../../../lib/firebaseAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  try {
    const { jobId } = req.body || {};
    if (!jobId) return res.status(400).json({ ok: false, error: "Missing jobId" });

    const db = getAdminDb();
    const ref = db.collection("jobs").doc(jobId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "job not found" });

    const preflight = (snap.get("preflight") || {}) as any;
    preflight.dispatcherDone = true;

    // compute ready if tech already done
    const techDone = !!preflight.techDone;
    let status = (snap.get("status") as string) || "scheduled";
    if (techDone && status === "scheduled") status = "ready";

    await ref.set({ preflight, status }, { merge: true });
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error("preflight dispatcher error", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || "preflight-dispatcher-failed" });
  }
}
