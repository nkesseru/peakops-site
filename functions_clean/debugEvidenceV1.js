const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function toStr(v) {
  return String(v || "").trim();
}

function isDevOnlyAllowed() {
  return process.env.FUNCTIONS_EMULATOR === "true" || process.env.NODE_ENV !== "production";
}

async function resolveEvidenceDoc({ db, incidentId, orgId = "", evidenceId = "", storagePath = "" }) {
  const { getEvidenceDocRef, getEvidenceCollectionRef } = await import("./evidenceRefs.mjs");
  const col = getEvidenceCollectionRef(db, incidentId);
  const oid = toStr(orgId);
  const eid = toStr(evidenceId);
  const sp = toStr(storagePath);

  async function byStoragePath(path) {
    const p = toStr(path);
    if (!p) return { ok: false, error: "not_found_by_storagePath", docs: [] };
    const matches = new Map();
    for (const field of ["file.storagePath", "storagePath", "file.objectName"]) {
      const snap = await col.where(field, "==", p).limit(25).get().catch(() => ({ docs: [] }));
      for (const d of (snap.docs || [])) matches.set(d.ref.path, d);
    }
    let docs = Array.from(matches.values());
    if (oid) docs = docs.filter((d) => toStr((d.data() || {}).orgId) === oid);
    if (!docs.length) return { ok: false, error: "not_found_by_storagePath", docs: [] };
    if (docs.length > 1) return { ok: false, error: "ambiguous_docs", docs };
    return { ok: true, ref: docs[0].ref, snap: docs[0], resolvedBy: "storagePath" };
  }

  if (sp) {
    const out = await byStoragePath(sp);
    if (out.ok || out.error === "ambiguous_docs") return out;
  }
  if (eid) {
    const ref = getEvidenceDocRef(db, incidentId, eid);
    const snap = await ref.get();
    if (snap.exists) {
      const doc = snap.data() || {};
      if (!oid || toStr(doc.orgId) === oid) return { ok: true, ref, snap, resolvedBy: "evidenceId" };
    }
  }
  if (!sp && eid) {
    const out = await byStoragePath(eid);
    if (out.ok || out.error === "ambiguous_docs") return out;
  }
  return { ok: false, error: "not_found" };
}

exports.debugEvidenceV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (!isDevOnlyAllowed()) return j(res, 403, { ok: false, error: "dev_only" });
    if (req.method !== "GET" && req.method !== "POST") return j(res, 405, { ok: false, error: "GET/POST required" });

    const q = req.method === "GET" ? (req.query || {}) : (req.body || {});
    const orgId = toStr(q.orgId);
    const incidentId = toStr(q.incidentId);
    const evidenceId = toStr(q.evidenceId);
    const storagePath = toStr(q.storagePath);
    if (!incidentId || (!evidenceId && !storagePath)) {
      return j(res, 400, { ok: false, error: "incidentId and evidenceId|storagePath required" });
    }

    const resolved = await resolveEvidenceDoc({
      db: getFirestore(),
      incidentId,
      orgId,
      evidenceId,
      storagePath,
    });
    if (!resolved.ok) {
      if (resolved.error === "ambiguous_docs") {
        return j(res, 409, {
          ok: false,
          error: "ambiguous_docs",
          incidentId,
          evidenceId,
          storagePath,
          docPaths: (resolved.docs || []).map((d) => d.ref.path),
        });
      }
      return j(res, 404, {
        ok: false,
        error: storagePath ? "not_found_by_storagePath" : "not_found",
        evidenceDocPath: `incidents/${incidentId}/evidence_locker/${evidenceId || "(unknown)"}`,
        incidentId,
        evidenceId,
        storagePath,
      });
    }
    const ref = resolved.ref;
    const snap = resolved.snap;
    const doc = snap.data() || {};
    if (orgId && toStr(doc.orgId) && toStr(doc.orgId) !== orgId) {
      return j(res, 403, { ok: false, error: "org_mismatch" });
    }
    const file = (doc.file && typeof doc.file === "object") ? doc.file : {};
    return j(res, 200, {
      ok: true,
      evidenceDocPath: ref.path,
      resolvedBy: resolved.resolvedBy || "",
      doc: {
        id: toStr(doc.evidenceId) || toStr(ref.id) || evidenceId,
        orgId: toStr(doc.orgId),
        incidentId: toStr(doc.incidentId),
        jobId: toStr(doc.jobId || doc?.evidence?.jobId || ""),
        file: {
          bucket: toStr(file.bucket || ""),
          storagePath: toStr(file.storagePath || ""),
          contentType: toStr(file.contentType || ""),
          originalName: toStr(file.originalName || ""),
          conversionStatus: toStr(file.conversionStatus || ""),
          conversionError: toStr(file.conversionError || ""),
          previewPath: toStr(file.previewPath || ""),
          thumbPath: toStr(file.thumbPath || ""),
          convertedJpgPath: toStr(file.convertedJpgPath || ""),
          thumbnailPath: toStr(file.thumbnailPath || ""),
          derivatives: file.derivatives || {},
        },
      },
    });
  } catch (e) {
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
