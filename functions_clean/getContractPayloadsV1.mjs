import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// CONTRACTS V1 — FROZEN
// Do not modify behavior or schema without a version bump (v2).
// Safe edits: UI cosmetics, copy, logging.


if (!getApps().length) initializeApp();
const db = getFirestore();

export async function handleGetContractPayloadsV1(req, res) {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" });
    if (!contractId) return res.status(400).json({ ok: false, error: "Missing contractId" });

    // NOTE: subcollection name is case-sensitive. You created "payloads" (lowercase).
    const ref = db.collection("contracts").doc(contractId).collection("payloads");

    // If you later add ordering fields consistently, you can orderBy updatedAt.
    // For now we just fetch up to limit; Firestore returns in doc-id order.
    const snap = await ref.limit(limit).get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, orgId, contractId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
