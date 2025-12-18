import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

if (!admin.apps.length) admin.initializeApp();

function safeJsonParse(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try { return JSON.parse(body); } catch { return {}; }
}

export const generateFilingPackageAndPersist = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    // Body might be object or string depending on middleware/emulator
    const parsed = safeJsonParse(req.body);

    const incidentId = parsed.incidentId;
    const orgId = parsed.orgId;
    const draftsByType = parsed.draftsByType && typeof parsed.draftsByType === "object"
      ? parsed.draftsByType
      : {};
    const compliance = parsed.compliance ?? null;
    const generatorVersion = parsed.generatorVersion ?? "v1";

    if (!incidentId || !orgId) {
      return res.status(400).json({
        ok: false,
        error: "Missing incidentId or orgId",
        gotKeys: Object.keys(parsed || {}),
      });
    }

    const filingTypes = Object.keys(draftsByType);
    if (filingTypes.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "draftsByType is empty or missing",
        gotKeys: Object.keys(parsed || {}),
      });
    }

    const db = admin.firestore();
    const now = new Date().toISOString();
    const batch = db.batch();

    for (const [type, draft] of Object.entries(draftsByType)) {
      const ref = db.collection("incidents").doc(incidentId).collection("filings").doc(type);
      batch.set(ref, {
        id: type,
        orgId,
        incidentId,
        type,
        status: "DRAFT",
        payload: draft?.payload ?? {},
        complianceSnapshot: compliance,
        generatedAt: draft?.generatedAt ?? now,
        generatorVersion,
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
      message: "Persisted filing drafts (hardened endpoint)",
      context: {
        filingTypes,
        complianceOk: compliance?.ok ?? null,
      },
      actor: { type: "SYSTEM" },
      createdAt: now,
    });

    await batch.commit();
    return res.json({ ok: true, persisted: filingTypes, systemLogId: logRef.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
