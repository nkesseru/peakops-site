const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_GENERATE_REPORT,
} = require("./_authz");
const { extractActorUid } = require("./_actor");

if (!getApps().length) initializeApp();
const db = getFirestore();

function readJson(req) {
  try {
    if (req.body && typeof req.body === "object") return req.body;
    if (req.rawBody) return JSON.parse(req.rawBody.toString("utf8") || "{}");
  } catch {}
  return {};
}

exports.generateFilingsV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const payload = readJson(req);
    const orgId = String(payload.orgId || req.query.orgId || "").trim();
    const incidentId = String(payload.incidentId || req.query.incidentId || "").trim();
    if (!orgId || !incidentId) return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });

    // PEAKOPS_AUTHZ_ROLE_RETROFIT_V1 (2026-05-06)
    // Phase 1 Slice 4: filing generation is admin-or-supervisor only.
    // Filings (DIRS / OE-417 drafts today) are compliance-shaped
    // artifacts so the gate runs before any read of the incident.
    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, payload));
      const gate = await assertActorRole(orgId, actorUid, ROLES_GENERATE_REPORT);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      console.warn("[generateFilingsV1] authz_denied", {
        fn: "generateFilingsV1",
        orgId,
        incidentId,
        uid: actorUid,
        role: (e && e.details && e.details.role) || null,
        requiredRoles: (e && e.details && e.details.allowedRoles) || ROLES_GENERATE_REPORT,
        code: e && e.code,
      });
      return res.status(httpStatusFromAuthzError(e)).json({
        ok: false,
        error: (e && e.code) || "permission-denied",
      });
    }
    console.log("[generateFilingsV1] authz_ok", {
      fn: "generateFilingsV1",
      orgId,
      incidentId,
      uid: actorUid,
      role: actorRole,
      requiredRoles: ROLES_GENERATE_REPORT,
    });

    // requestedBy now prefers the verified actor uid; payload field
    // remains as a legacy fallback for callers that don't yet send a
    // Firebase Auth bearer token.
    const requestedBy = String(actorUid || payload.requestedBy || req.query.requestedBy || "unknown").trim();

    let incidentRef = db.doc(`orgs/${orgId}/incidents/${incidentId}`);
    let snap = await incidentRef.get();
    if (!snap.exists) {
      incidentRef = db.collection("incidents").doc(incidentId);
      snap = await incidentRef.get();
    }

    // IMMUTABILITY_GUARD_C2
    const force = String((req.query && req.query.force) || (payload && payload.force) || (req.body && req.body.force) || "") === "1";
    const incident = snap.exists ? (snap.data() || {}) : {};
    if (incident.immutable === true && !force) {
      return res.status(409).json({ ok: false, error: "IMMUTABLE: Incident is finalized" });
    }

    if (!snap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    const nowIso = new Date().toISOString();
    const nowTs = Timestamp.now();

    const filings = [
      { id:"dirs_draft",  type:"DIRS",  status:"DRAFT", title:"DIRS draft",   updatedAt: nowIso },
      { id:"oe417_draft", type:"OE_417", status:"DRAFT", title:"OE-417 draft", updatedAt: nowIso },
    ];

    const batch = db.batch();
    const col = incidentRef.collection("filings");
    for (const f of filings) {
      batch.set(col.doc(f.id), {
        ...f, orgId, incidentId, requestedBy,
        createdAt: nowTs,
        updatedAtTs: nowTs,
      }, { merge:true });
    }

    batch.set(incidentRef.collection("timeline_events").doc("t2_filings"), {
      id:"t2_filings",
      type:"FILINGS_GENERATED",
      title:"Filings generated",
      message:"Stub filings generated.",
      occurredAt: nowIso,
      orgId, incidentId, requestedBy,
      createdAt: nowTs,
      updatedAt: nowTs,
    }, { merge:true });

    await batch.commit();
    return res.status(200).json({ ok:true, orgId, incidentId, requestedBy, count: filings.length, docs: filings });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});
