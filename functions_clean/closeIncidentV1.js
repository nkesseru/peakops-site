const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { emitTimelineEvent } = require("./timelineEmit");
const { INCIDENT_STATUS, normalizeIncidentStatus, canTransitionIncident } = require("./incidentState");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function roleFromText(v) {
  return String(v || "").trim().toLowerCase();
}

function isPrivilegedRole(role) {
  return role === "owner" || role === "admin";
}

async function resolveActor(req, body) {
  const authz = String(req.headers.authorization || "").trim();
  const roleHeader = roleFromText(req.headers["x-peakops-role"]);
  const roleBody = roleFromText(body.actorRole || body.role);
  const uidBody = String(body.actorUid || "").trim();

  let uid = "";
  let role = roleHeader || roleBody;
  let claimsOrgId = "";

  if (authz.toLowerCase().startsWith("bearer ")) {
    const token = authz.slice(7).trim();
    if (token) {
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        uid = String(decoded?.uid || "").trim();
        const claimRole = roleFromText(decoded?.role || decoded?.app_role);
        claimsOrgId = String(decoded?.orgId || decoded?.org_id || "").trim();
        if (claimRole) role = claimRole;
      } catch {
        // keep fallback behavior below
      }
    }
  }

  if (!uid && uidBody) uid = uidBody;
  return { uid, role, claimsOrgId };
}

async function assertClosePermission({ db, orgId, actor, req }) {
  if (!isPrivilegedRole(actor.role)) {
    const err = new Error("forbidden_role");
    err.statusCode = 403;
    throw err;
  }

  if (actor.claimsOrgId && actor.claimsOrgId !== orgId) {
    const err = new Error("org_mismatch");
    err.statusCode = 409;
    throw err;
  }

  if (actor.uid) {
    const memberRef = db.collection("orgs").doc(orgId).collection("members").doc(actor.uid);
    const memberSnap = await memberRef.get();
    if (memberSnap.exists) {
      const m = memberSnap.data() || {};
      const memberRole = roleFromText(m.role);
      if (isPrivilegedRole(memberRole)) return;
      const err = new Error("forbidden_role");
      err.statusCode = 403;
      throw err;
    }
  }

  // Emulator/dev convenience; production requires authenticated org membership.
  const isEmulator = String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true";
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (!isProd || isEmulator) return;

  const err = new Error("auth_required");
  err.statusCode = 403;
  throw err;
}

// POST body: { orgId, incidentId, closedBy? }
exports.closeIncidentV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") return j(res, 405, { ok: false, error: "POST required" });

    const body = (typeof req.body === "object" && req.body) ? req.body : {};
    const orgId = mustStr(body.orgId, "orgId");
    const incidentId = mustStr(body.incidentId, "incidentId");
    const db = getFirestore();
    const actor = await resolveActor(req, body);
    await assertClosePermission({ db, orgId, actor, req });
    const closedBy = String(body.closedBy || actor.uid || "ui");
    const forceClose = String(body.forceClose || "").toLowerCase() === "true" || body.forceClose === true;
    const isDevLike =
      String(process.env.NODE_ENV || "").toLowerCase() !== "production" ||
      String(process.env.FUNCTIONS_EMULATOR || "").toLowerCase() === "true";

    const incRef = db.collection("incidents").doc(incidentId);
    const snap = await incRef.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const status = normalizeIncidentStatus(data.status);

    if (status === INCIDENT_STATUS.CLOSED) {
      return j(res, 200, { ok: true, orgId, incidentId, status: "closed", already: true });
    }
    if (String(data.orgId || "").trim() && String(data.orgId || "").trim() !== orgId) {
      return j(res, 409, { ok: false, error: "org_mismatch" });
    }
    if (!canTransitionIncident(status, INCIDENT_STATUS.CLOSED)) {
      return j(res, 409, {
        ok: false,
        error: "invalid_transition",
        detail: `closeIncident current=${status}`,
      });
    }

    if (forceClose && !isDevLike) {
      return j(res, 403, { ok: false, error: "force_close_not_allowed_in_production" });
    }
    if (!forceClose) {
      const jobsSnap = await incRef.collection("jobs").limit(500).get();
      const blocked = jobsSnap.docs
        .map((d) => ({ id: d.id, ...(d.data() || {}) }))
        .filter((job) => {
          const rs = String(job.reviewStatus || "").trim().toLowerCase();
          const st = String(job.status || "").trim().toLowerCase();
          const approved = rs === "approved" || st === "approved";
          return !approved;
        })
        .slice(0, 20)
        .map((job) => ({
          jobId: String(job.id || ""),
          title: String(job.title || ""),
          status: String(job.status || ""),
          reviewStatus: String(job.reviewStatus || ""),
        }));
      if (blocked.length) {
        return j(res, 409, {
          ok: false,
          error: "close_blocked_jobs_not_approved",
          reasons: blocked,
          hint: "Approve all jobs first or use forceClose in dev.",
        });
      }
    }

    await incRef.set(
      {
        orgId,
        incidentId,
        status: INCIDENT_STATUS.CLOSED,
        closedAt: FieldValue.serverTimestamp(),
        closedBy,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await emitTimelineEvent({ orgId, incidentId, type: "incident_closed", actor: "ui" });
    return j(res, 200, { ok: true, orgId, incidentId, status: "closed" });
  } catch (e) {
    const status = Number(e?.statusCode || 400);
    return j(res, status, { ok: false, error: String(e?.message || e) });
  }
});
