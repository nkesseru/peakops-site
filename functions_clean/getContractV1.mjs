import { getFirestore } from "firebase-admin/firestore";

export async function handleGetContractV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    if (!orgId) return res.status(400).json({ ok:false, error:"Missing orgId" });
    if (!contractId) return res.status(400).json({ ok:false, error:"Missing contractId" });

    const db = getFirestore();
    const ref = db.collection("contracts").doc(contractId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Contract not found" });

    const data = snap.data() || {};
    if (String(data.orgId || "") !== orgId) {
      return res.status(403).json({ ok:false, error:"Wrong orgId for contract" });
    }
    return res.json({ ok:true, orgId, contractId, doc: { id:snap.id, ...data }});
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
