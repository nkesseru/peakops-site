import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

if (!admin.apps.length) admin.initializeApp();

export const hello = onRequest((req, res) => {
  res.json({ ok: true, msg: "hello from functions_clean" });
});

export const generateFilingPackageAndPersist = onRequest(async (req, res) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const incidentId = body.incidentId;
    const orgId = body.orgId;
    const draftsByType = (body.draftsByType && typeof body.draftsByType === "object") ? body.draftsByType : null;

    if (!incidentId || !orgId) return res.status(400).json({ ok:false, error:"missing incidentId/orgId" });
    if (!draftsByType) return res.status(400).json({ ok:false, error:"missing draftsByType" });

    const filingTypes = Object.keys(draftsByType);
    if (filingTypes.length === 0) return res.status(400).json({ ok:false, error:"empty draftsByType" });

    const db = admin.firestore();
    const now = new Date().toISOString();
    const batch = db.batch();

    for (const type of filingTypes) {
      const draft = draftsByType[type] ?? {};
      batch.set(
        db.collection("incidents").doc(incidentId).collection("filings").doc(type),
        {
          id: type,
          orgId,
          incidentId,
          type,
          status: "DRAFT",
          payload: draft.payload ?? {},
          generatedAt: draft.generatedAt ?? now,
          generatorVersion: body.generatorVersion ?? "v1",
          createdAt: now,
          updatedAt: now,
          createdBy: "system"
        },
        { merge: true }
      );
    }

    const logRef = db.collection("system_logs").doc();
    batch.set(logRef, {
      orgId,
      incidentId,
      level: "INFO",
      event: "filing.package.persisted",
      message: "Persisted filing drafts (functions_clean)",
      context: { filingTypes },
      actor: { type: "SYSTEM" },
      createdAt: now
    });

    await batch.commit();
    return res.json({ ok:true, persisted: filingTypes, systemLogId: logRef.id });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e) });
  }
});
