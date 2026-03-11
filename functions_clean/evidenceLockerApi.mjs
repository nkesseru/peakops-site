import { getFirestore } from "firebase-admin/firestore";
import { getEvidenceCollectionRef } from "./evidenceRefs.mjs";

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
    const out = await listEvidenceLockerCore(db, { orgId, incidentId, limit });
    const docs = out.docs || [];
    return res.json({ ok:true, orgId, incidentId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e), count: 0, docs: [] });
  }
}


// ---- Compatibility exports (for exportRegPacketV1) ----

export async function listEvidenceLockerCore(db, { orgId, incidentId, limit=25 } = {}) {
  if (!incidentId) return { ok:false, error:"Missing incidentId", orgId, incidentId, count:0, docs:[] };
  const cap = Math.min(Number(limit || 25), 500);
  const scan = orgId ? Math.min(cap * 3, 500) : cap;
  const snap = await getEvidenceCollectionRef(db, String(incidentId))
    .orderBy("storedAt","desc")
    .limit(scan)
    .get()
    .catch(() => null);

  const docsAll = snap
    ? snap.docs.map((d) => {
        const raw = { id: d.id, ...(d.data() || {}) };
        const topJobId = String(raw?.jobId || "").trim();
        const nestedJobId = String(raw?.evidence?.jobId || "").trim();
        if (!topJobId && nestedJobId) {
          return { ...raw, jobId: nestedJobId };
        }
        return raw;
      })
    : [];
  const docs = orgId
    ? docsAll.filter((d) => String(d.orgId || "") === String(orgId)).slice(0, cap)
    : docsAll.slice(0, cap);
  return { ok:true, orgId, incidentId, count: docs.length, docs };
}
