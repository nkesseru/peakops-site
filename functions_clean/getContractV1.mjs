import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

async function getContractV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    if (!orgId || !contractId) return res.status(400).json({ ok: false, error: "Missing orgId/contractId" });

    const db = getFirestore();

    const snap = await db.collection("contracts").doc(contractId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "Contract not found" });

    const doc = { id: snap.id, ...snap.data() };
    if (String(doc.orgId || "") !== orgId) return res.status(404).json({ ok: false, error: "Contract not found" });

    return res.json({ ok: true, orgId, contractId, doc });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

export default onRequest(getContractV1);
