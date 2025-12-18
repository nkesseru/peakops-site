import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

if (!admin.apps.length) admin.initializeApp();

export const generateFilingPackageAndPersist = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    const { incidentId, orgId, draftsByType, compliance, generatorVersion } = req.body ?? {};
    if (!incidentId || !orgId || !draftsByType) {
      return res.status(400).json({ ok: false, error: "Missing incidentId/orgId/draftsByType" });
    }

    const db = admin.firestore();
    const now = new Date().toISOString();
    const batch = db.batch();

    for (const [type, draft] of Object.entries(draftsByType)) {
      const ref = db.collection("incidents").doc(incidentId).collection("filings").doc(type);
      batch.set(
        ref,
        {
          id: type,
          orgId,
          incidentId,
          type,
          status: "DRAFT",
          payload: draft?.payload ?? {},
          complianceSnapshot: compliance ?? null,
          generatedAt: draft?.generatedAt ?? now,
          generatorVersion: generatorVersion ?? "v1",
          createdAt: now,
          updatedAt: now,
          createdBy: "system",
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
      message: "Persisted filing drafts (minimal endpoint)",
      context: {
        filingTypes: Object.keys(draftsByType),
        complianceOk: compliance?.ok ?? null,
      },
      actor: { type: "SYSTEM" },
      createdAt: now,
    });

    await batch.commit();
    return res.json({ ok: true, persisted: Object.keys(draftsByType), systemLogId: logRef.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
