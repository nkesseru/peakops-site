import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldPath } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export default async function getContractsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    // Cursor inputs (both required to paginate)
    const cursorUpdatedAtMsRaw = req.query.cursorUpdatedAtMs;
    const cursorId = String(req.query.cursorId || "").trim();

    if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" });

    let q = db.collection("contracts")
      .where("orgId", "==", orgId)
      .orderBy("updatedAt", "desc")
      .orderBy(FieldPath.documentId(), "desc")
      .limit(limit);

    // If cursor provided, use startAfter(updatedAt, docId)
    if (cursorUpdatedAtMsRaw !== undefined && cursorUpdatedAtMsRaw !== null && String(cursorUpdatedAtMsRaw).trim() !== "" && cursorId) {
      const ms = Number(cursorUpdatedAtMsRaw);
      if (!Number.isFinite(ms) || ms <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid cursorUpdatedAtMs" });
      }
      const ts = Timestamp.fromMillis(ms);
      q = q.startAfter(ts, cursorId);
    }

    const snap = await q.get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // next cursor = last doc in this page
    let nextCursor = null;
    if (snap.docs.length > 0) {
      const last = snap.docs[snap.docs.length - 1];
      const data = last.data() || {};
      const updatedAt = data.updatedAt;
      // expect Timestamp; tolerate others
      let nextMs = null;
      if (updatedAt && typeof updatedAt === "object" && typeof updatedAt.toMillis === "function") nextMs = updatedAt.toMillis();
      if (updatedAt && typeof updatedAt === "object" && typeof updatedAt._seconds === "number") nextMs = updatedAt._seconds * 1000;
      if (typeof updatedAt === "string") {
        const t = Date.parse(updatedAt);
        if (!Number.isNaN(t)) nextMs = t;
      }
      nextCursor = (nextMs && last.id) ? { cursorUpdatedAtMs: nextMs, cursorId: last.id } : null;
    }

    return res.json({ ok: true, orgId, count: docs.length, docs, nextCursor });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
