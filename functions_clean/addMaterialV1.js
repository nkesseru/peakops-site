const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_FIELD_WORK,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function normNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// POST body:
// { orgId, incidentId, sessionId, category, name, qty, unit, notes?, baba? }
exports.addMaterialV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok:false, error:"POST required" });

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const sessionId = mustStr(body.sessionId, "sessionId");

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 5: material capture is field-or-above. Upgraded
    // from the Slice 3 membership-only gate for symmetry with the
    // rest of the field-work surface (addEvidence, submitFieldSession,
    // assignEvidenceToJob). NOTE: this function is not currently
    // exported from functions_clean/index.js and so is not verifiable
    // via live emulator smoke; the gate is structurally correct and
    // ready to fire the moment it's wired into the index.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, body));
      const gate = await assertActorRole(orgId, actorUid, ROLES_FIELD_WORK);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[addMaterialV1] authz_denied", {
        fn: "addMaterialV1",
        orgId,
        incidentId,
        sessionId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_FIELD_WORK,
        code: e && e.code,
      });
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[addMaterialV1] authz_ok", {
      fn: "addMaterialV1",
      orgId,
      incidentId,
      sessionId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_FIELD_WORK,
    });

    const category = mustStr(body.category, "category").toUpperCase();
    const name = mustStr(body.name, "name");
    const qty = normNum(body.qty, 1);
    const unit = String(body.unit || "ea");
    const notes = String(body.notes || "").slice(0, 500);

    const baba = body.baba && typeof body.baba === "object"
      ? {
          originCountry: String(body.baba.originCountry || ""),
          manufacturer: String(body.baba.manufacturer || ""),
          domesticContentPercent: normNum(body.baba.domesticContentPercent, null),
          certEvidenceId: String(body.baba.certEvidenceId || "")
        }
      : null;

    const db = getFirestore();

    // PEAKOPS_SEALED_RECORD_V1 (2026-05-18, PR 41)
    // Sealed records are immutable. Reject material additions
    // post-closure. Post-closure material/parts context goes through
    // the addendum model (PR 43).
    const sealIncSnap = await db.collection("incidents").doc(incidentId).get();
    const sealIncStatus = String((sealIncSnap.exists ? (sealIncSnap.data() || {}) : {}).status || "").toLowerCase();
    if (sealIncStatus === "closed") {
      return j(res, 409, {
        ok: false,
        error: "incident_closed",
        detail: "Operational record is sealed — file an addendum to attach supplemental context.",
      });
    }

    // verify session exists (org-scoped)
    const sesRef = db.collection("orgs").doc(orgId)
      .collection("incidents").doc(incidentId)
      .collection("fieldSessions").doc(sessionId);

    const sesSnap = await sesRef.get();
    if (!sesSnap.exists) return j(res, 404, { ok:false, error:"session not found" });

    const matRef = db.collection("orgs").doc(orgId)
      .collection("incidents").doc(incidentId)
      .collection("materials").doc();

    const now = FieldValue.serverTimestamp();

    await matRef.set({
      orgId,
      incidentId,
      sessionId,
      materialId: matRef.id,
      category,
      name,
      qty,
      unit,
      notes,
      baba,
      addedAt: now,
      version: 1
    });

    await emitTimelineEvent({ orgId, incidentId, type: "MATERIAL_ADDED", sessionId, refId: matRef.id, actor: "field" });

    return j(res, 200, {
      ok:true,
      orgId,
      incidentId,
      sessionId,
      materialId: matRef.id
    });
  } catch (e) {
    return j(res, 400, { ok:false, error:String(e?.message || e) });
  }
});
