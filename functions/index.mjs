import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

if (!admin.apps.length) admin.initializeApp();

export const hello = onRequest((req, res) => {
  res.json({ ok: true, msg: "functions emulator is loading index.mjs" });
});

export const generateFilingPackageAndPersist = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const incidentId = body.incidentId;
    const orgId = body.orgId;
    const draftsByType = (body.draftsByType && typeof body.draftsByType === "object") ? body.draftsByType : {};
    const compliance = body.compliance ?? null;

    const filingTypes = Object.keys(draftsByType);

    if (!incidentId || !orgId) {
      return res.status(400).json({ ok: false, error: "Missing incidentId/orgId", gotKeys: Object.keys(body) });
    }
    if (filingTypes.length === 0) {
      return res.status(400).json({ ok: false, error: "draftsByType missing/empty", gotKeys: Object.keys(body) });
    }

    const db = admin.firestore();
    const now = new Date().toISOString();
    const batch = db.batch();

    for (const type of filingTypes) {
      const draft = draftsByType[type] || {};
      const ref = db.collection("incidents").doc(incidentId).collection("filings").doc(type);
      batch.set(ref, {
        id: type,
        orgId,
        incidentId,
        type,
        status: "DRAFT",
        payload: draft.payload ?? {},
        complianceSnapshot: compliance,
        generatedAt: draft.generatedAt ?? now,
        generatorVersion: body.generatorVersion ?? "v1",
        createdAt: now,
        updatedAt: now,
        createdBy: "system",
      }, { merge: true });
    }

    const logRef = db.collection("system_logs").doc();
    batch.set(logRef, {
      orgId,
      incidentId,
      level: "INFO",
      event: "filing.package.persisted",
      message: "Persisted filing drafts (stable endpoint)",
      context: { filingTypes, complianceOk: compliance?.ok ?? null },
      actor: { type: "SYSTEM" },
      createdAt: now,
    });

    await batch.commit();
    return res.json({ ok: true, persisted: filingTypes, systemLogId: logRef.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
