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
  kind,           // SUBMISSION_REQUEST | SUBMISSION_RESPONSE | WORKER_EVENT | ...
  payload,        // object (request/response/etc)
  adapter,        // { provider, system, adapterVersion }
  traceId,
  correlationId,
  idempotencyKey,
  meta,
  source,         // "submitQueueWorker@local" etc
} = {}) {
  if (!db) throw new Error("writeEvidenceLocker: missing db");
  if (!orgId) throw new Error("writeEvidenceLocker: missing orgId");
  if (!incidentId) throw new Error("writeEvidenceLocker: missing incidentId");
  if (!kind) throw new Error("writeEvidenceLocker: missing kind");

  const storedAt = Timestamp.now();

  // Canonical payload + hash
  const canon = stableStringify(payload ?? null);
  const hash = sha256Hex(canon);
  const bytes = Buffer.byteLength(canon, "utf8");

  // Keep Firestore doc lean (preview + optional inline payload)
  const preview = canon.length > 4000 ? canon.slice(0, 4000) + "\n…(truncated)" : canon;
  const payloadTooBig = bytes > 25_000; // conservative; you can tune this

  const ref = db.collection("incidents").doc(String(incidentId))
    .collection("evidence_locker").doc();

  const doc = {
    id: ref.id,
    orgId,
    incidentId,
    filingType: filingType || "",
    jobId: jobId || "",
    kind,
    storedAt,

    hash: { algo: "SHA256", value: hash },
    payloadBytes: bytes,

    payloadPreview: preview,
    payloadTruncated: payloadTooBig || canon.length > 4000,

    // store inline only if small enough
    payload: payloadTooBig ? null : (payload ?? null),

    adapter: (adapter && typeof adapter === "object") ? adapter : {},
    traceId: traceId || "",
    correlationId: correlationId || "",
    idempotencyKey: idempotencyKey || "",

    source: source || "system",
    meta: (meta && typeof meta === "object") ? meta : {},
  };

  await ref.set(doc, { merge: false });
  return { id: ref.id, hash };
}
