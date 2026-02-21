const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function s(v) {
  return String(v || "").trim();
}

exports.backfillEvidenceJobIdV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
      return j(res, 404, { ok: false, error: "not_available_in_production" });
    }
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });
    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = s(body.orgId);
    const incidentId = s(body.incidentId);
    const dryRun = String(body.dryRun || "").toLowerCase() === "true";
    if (!orgId || !incidentId) return j(res, 400, { ok: false, error: "orgId and incidentId required" });

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return j(res, 404, { ok: false, error: "incident_not_found" });
    const inc = incSnap.data() || {};
    if (s(inc.orgId) && s(inc.orgId) !== orgId) return j(res, 409, { ok: false, error: "org_mismatch" });
    if (s(inc.status).toLowerCase() === "closed") return j(res, 409, { ok: false, error: "incident_closed" });

    const evRef = db.collection("incidents").doc(incidentId).collection("evidence_locker");
    const snap = await evRef.limit(500).get();
    const sample = [];
    let scanned = 0;
    let updated = 0;
    let resolvedByStoragePath = 0;
    const writes = [];
    const rows = [];
    const jobIdByStoragePath = new Map();

    for (const d of snap.docs) {
      scanned += 1;
      const doc = d.data() || {};
      if (s(doc.orgId) && s(doc.orgId) !== orgId) continue;
      const topJobId = s(doc.jobId);
      const nestedJobId = s((doc.evidence || {}).jobId);
      const storagePath = s((doc.file || {}).storagePath || doc.storagePath || (doc.file || {}).objectName);
      rows.push({ ref: d.ref, id: d.id, topJobId, nestedJobId, storagePath });
      const knownJob = topJobId || nestedJobId;
      if (knownJob && storagePath) jobIdByStoragePath.set(storagePath, knownJob);
    }

    for (const row of rows) {
      const { ref, id, topJobId, nestedJobId, storagePath } = row;
      if (topJobId) continue;
      let resolvedJobId = nestedJobId;
      if (!resolvedJobId && storagePath) {
        resolvedJobId = s(jobIdByStoragePath.get(storagePath));
        if (resolvedJobId) resolvedByStoragePath += 1;
      }
      if (!resolvedJobId) continue;
      updated += 1;
      if (sample.length < 10) {
        sample.push({
          id,
          before: { jobId: topJobId || "", evidenceJobId: nestedJobId || "" },
          after: { jobId: resolvedJobId },
          resolvedBy: nestedJobId ? "nested" : "storagePath",
        });
      }
      if (!dryRun) {
        writes.push(
          ref.set(
            {
              jobId: resolvedJobId,
              evidence: { jobId: resolvedJobId },
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        );
      }
    }

    if (!dryRun && writes.length) await Promise.all(writes);
    return j(res, 200, {
      ok: true,
      orgId,
      incidentId,
      dryRun,
      scanned,
      updated,
      resolvedByStoragePath,
      sample,
    });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
