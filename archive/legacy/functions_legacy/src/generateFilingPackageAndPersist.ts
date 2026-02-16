import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";

import { IncidentZ } from "../../contracts/validators/incident.zod";
import { generateFilingPackage } from "../../filing/generatePackage";
import { persistFilingPackage } from "../../filing/persistPackage";

if (!admin.apps.length) {
  admin.initializeApp();
}

export const generateFilingPackageAndPersist = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Use POST" });
      return;
    }

    const { incident, evidenceTypesPresent, actorUserId } = req.body ?? {};

    const incidentValidated = IncidentZ.parse(incident);
    const evidence: string[] = Array.isArray(evidenceTypesPresent) ? evidenceTypesPresent : [];

    const pkg = generateFilingPackage(incidentValidated, evidence);

    const db = admin.firestore();
    const result = await persistFilingPackage(db, pkg, { actorUserId });

    res.json({ ok: true, pkgMeta: {
      incidentId: pkg.incidentId,
      orgId: pkg.orgId,
      generatorVersion: pkg.generatorVersion,
      generatedAt: pkg.generatedAt,
      filingTypes: Object.keys(pkg.draftsByType),
      complianceOk: pkg.compliance.ok
    }, persist: result });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message ?? String(err) });
  }
});
