import { getFirestore } from "firebase-admin/firestore";

export async function handleListEvidenceLockerRequest(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 25)));

    if (!orgId || !incidentId) {
      return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });
    }

    const db = getFirestore();
    const snap = await db
      .collection("incidents").doc(incidentId)
      .collection("evidence_locker")
      .orderBy("storedAt", "desc")
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, orgId, incidentId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}


// ---- Compatibility exports (for exportRegPacketV1) ----

export async function listEvidenceLockerCore(db, { orgId, incidentId, limit=25 } = {}) {
  if (!orgId || !incidentId) return { ok:false, error:"Missing orgId/incidentId", orgId, incidentId, count:0, docs:[] };
  const snap = await db.collection("incidents").doc(String(incidentId))
    .collection("evidence_locker")
    .orderBy("storedAt","desc")
    .limit(Math.min(Number(limit||25), 500))
    .get()
    .catch(() => null);

  const docs = snap ? snap.docs.map(d => ({ id:d.id, ...(d.data()||{}) })) : [];
  return { ok:true, orgId, incidentId, count: docs.length, docs };
}
