import type { Firestore } from "firebase-admin/firestore";
import { sha256OfObject } from "../utils/sha256";
import type { FilingPackage } from "./generatePackage";

type FilingDoc = {
  id: string;
  orgId: string;
  incidentId: string;
  type: string;
  status: "DRAFT";
  payload: Record<string, unknown>;
  payloadHash: { algo: "SHA256"; value: string };

  complianceSnapshot: any;
  complianceHash: { algo: "SHA256"; value: string };

  generatedAt: string;
  generatorVersion: string;

  createdAt: string;
  updatedAt: string;
  createdBy: string; // "system" for now
};

export async function persistFilingPackage(
  db: Firestore,
  pkg: FilingPackage,
  opts?: { actorUserId?: string }
) {
  const now = new Date().toISOString();
  const actorUserId = opts?.actorUserId ?? "system";

  const batch = db.batch();

  // hash compliance once
  const complianceHash = sha256OfObject(pkg.compliance).hash;

  // Write each filing doc under the incident
  for (const [type, draft] of Object.entries(pkg.draftsByType)) {
    const payloadHash = sha256OfObject(draft.payload).hash;

    const filingDoc: FilingDoc = {
      id: type,
      orgId: pkg.orgId,
      incidentId: pkg.incidentId,
      type,
      status: "DRAFT",
      payload: draft.payload,

      payloadHash: { algo: "SHA256", value: payloadHash },
      complianceSnapshot: pkg.compliance,
      complianceHash: { algo: "SHA256", value: complianceHash },

      generatedAt: pkg.generatedAt,
      generatorVersion: pkg.generatorVersion,

      createdAt: now,
      updatedAt: now,
      createdBy: actorUserId,
    };

    const ref = db
      .collection("incidents")
      .doc(pkg.incidentId)
      .collection("filings")
      .doc(type);

    batch.set(ref, filingDoc, { merge: true });
  }

  // System log entry (top-level)
  const log = {
    orgId: pkg.orgId,
    incidentId: pkg.incidentId,
    level: "INFO",
    event: "filing.package.generated",
    message: "Generated and persisted filing drafts + compliance snapshot",
    context: {
      filingTypes: Object.keys(pkg.draftsByType),
      generatorVersion: pkg.generatorVersion,
      generatedAt: pkg.generatedAt,
      complianceOk: pkg.compliance?.ok ?? null,
      complianceHash: complianceHash,
    },
    actor: { type: "SYSTEM" as const },
    createdAt: now,
  };

  const logRef = db.collection("system_logs").doc();
  batch.set(logRef, log);

  await batch.commit();

  return {
    ok: true,
    persisted: Object.keys(pkg.draftsByType),
    complianceHash,
    systemLogId: logRef.id,
  };
}
