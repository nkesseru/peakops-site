import { getFirestore } from "firebase-admin/firestore";

export async function listContractsV1(req, res) {
  try {
    const db = getFirestore();
    const snap = await db.collection("contracts").limit(50).get();
    const contracts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, contracts });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

export async function getContractV1(req, res) {
  try {
    const orgId = req.query.orgId || "org_001";
    const contractId = req.query.contractId;
    if (!contractId) return res.status(400).json({ ok:false, error:"Missing contractId" });

    const db = getFirestore();
    const doc = await db.collection("contracts").doc(String(contractId)).get();
    if (!doc.exists) return res.json({ ok:false, error:"Contract not found" });

    return res.json({ ok:true, orgId, contract: { id: doc.id, ...doc.data() } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}

export async function listContractPayloadsV1(req, res) {
  try {
    const orgId = req.query.orgId || "org_001";
    const contractId = req.query.contractId;
    if (!contractId) return res.status(400).json({ ok:false, error:"Missing contractId" });

    const db = getFirestore();
    const snap = await db.collection("contracts").doc(String(contractId)).collection("payloads").get();
    const payloads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, orgId, contractId, payloads });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
