import { getFirestore } from "firebase-admin/firestore";

// CONTRACTS V1 — FROZEN
// Do not modify behavior or schema without a version bump (v2).
// Safe edits: UI cosmetics, copy, logging.


export async function handleGetContractsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    if (!orgId) return res.status(400).json({ ok:false, error:"Missing orgId" });

    const db = getFirestore();
    const snap = await db.collection("contracts")
      .where("orgId","==",orgId)
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, orgId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
