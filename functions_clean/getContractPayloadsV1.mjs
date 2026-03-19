import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

async function getContractPayloadsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String((req.query.orgId ?? req.query.orgid ?? "")).trim();
    const contractId = String((req.query.contractId ?? req.query.contractid ?? req.query.id ?? "")).trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId || !contractId) return res.status(400).json({ ok: false, error: "Missing orgId/contractId" });

    const db = getFirestore();

    // verify contract belongs to org
    const cSnap = await db.collection("contracts").doc(contractId).get();
    if (!cSnap.exists) return res.status(404).json({ ok: false, error: "Contract not found" });
    const c = cSnap.data() || {};
    if (String(c.orgId || "") !== orgId) return res.status(404).json({ ok: false, error: "Contract not found" });

    const snap = await db.collection("contracts").doc(contractId)
      .collection("payloads")
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, orgId, contractId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

export default onRequest(getContractPayloadsV1);
