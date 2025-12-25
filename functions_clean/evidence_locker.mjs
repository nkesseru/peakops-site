import crypto from "crypto";
import { Timestamp } from "firebase-admin/firestore";

// Deterministic stringify for hashing (sort keys)
function stableSort(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stableSort);
  if (typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = stableSort(obj[k]);
    return out;
  }
  return obj;
}
function stableStringify(obj) {
  return JSON.stringify(stableSort(obj), null, 2);
}
function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

export async function writeEvidenceLocker(db, {
  orgId,
  incidentId,
  filingType,
  jobId,
  kind,              // SUBMISSION_REQUEST | SUBMISSION_RESPONSE | WORKER_EVENT
  payload,           // object (request/response/etc)
  adapter,           // { provider, system, adapterVersion }
  traceId,
  correlationId,
  idempotencyKey,
} = {}) {
  if (!orgId || !incidentId || !filingType || !kind) {
    throw new Error("EvidenceLocker: missing orgId/incidentId/filingType/kind");
  }

  const now = Timestamp.now();
  const payloadJson = stableStringify(payload ?? {});
  const payloadHash = sha256Hex(payloadJson);

  const doc = {
    orgId,
    incidentId,
    filingType,
    jobId: jobId || "",
    kind,
    traceId: traceId || "",
    correlationId: correlationId || "",
    idempotencyKey: idempotencyKey || "",

    adapter: {
      provider: adapter?.provider || "",
      system: adapter?.system || filingType,
      adapterVersion: adapter?.adapterVersion || "v1",
    },

    payloadHash: { algo: "SHA256", value: payloadHash },
    payload, // keep raw object for now (later: can store in GCS if huge)

    createdAt: now,
  };

  const ref = db.collection("incidents").doc(incidentId).collection("evidence_locker").doc();
  await ref.set({ id: ref.id, ...doc }, { merge: true });
  return { ok: true, evidenceId: ref.id, payloadHash };
}
