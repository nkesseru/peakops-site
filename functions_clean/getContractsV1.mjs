import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

export default async function getContractsV1(req, res) {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId) {
      return res.status(400).json({ ok: false, error: "Missing orgId" });
    }

    const db = getFirestore();

    // List contracts for org (simple + stable)
    let q = db.collection("contracts").where("orgId", "==", orgId).limit(limit);

    // Optional ordering (only if index exists); fall back if not
    try { q = q.orderBy("updatedAt", "desc"); } catch {}

    const snap = await q.get();

    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, orgId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
