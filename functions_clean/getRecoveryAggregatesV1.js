// PEAKOPS_RECOVERY_AGGREGATES_READ_V1 (PR 132b)
//
// Admin/coordinator read endpoint for the aggregate views built by
// the onRecoveryAuditWrite trigger. Returns rolling-window
// summaries computed from daily buckets at read time.
//
// Inputs:
//   GET ?orgId=X&type=recovery_metrics|cause_effectiveness|action_effectiveness
//       &windowDays=30|90|365
//
// Outputs:
//   recovery_metrics  → one summary object
//   cause_effectiveness → array of per-cause summaries
//   action_effectiveness → array of per-action-type summaries
//
// Architecture lock:
//   - Org-scoped (cross-org reads blocked by assertActorRole)
//   - Admin-only (PR 132b doesn't surface intelligence to field users)
//   - No PII: cause + action types are enum values, not user data
//   - No write side effects

require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_ADMIN_ONLY,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const {
  summarizeWindow,
  metricsDocId,
} = require("./_recoveryAggregators");

try { if (!admin.apps.length) admin.initializeApp(); } catch (_) {}

const ALLOWED_WINDOWS = new Set([30, 90, 365]);
const ALLOWED_TYPES = new Set([
  "recovery_metrics",
  "cause_effectiveness",
  "action_effectiveness",
]);

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function trimStr(v) { return String(v == null ? "" : v).trim(); }

exports.getRecoveryAggregatesV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "Use GET" });

    const orgId = trimStr(req.query?.orgId);
    const type = trimStr(req.query?.type);
    const windowDays = Number(req.query?.windowDays);

    if (!orgId) return j(res, 400, { ok: false, error: "Missing orgId" });
    if (!ALLOWED_TYPES.has(type)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_type",
        detail: `type must be one of: ${Array.from(ALLOWED_TYPES).join(", ")}`,
      });
    }
    if (!ALLOWED_WINDOWS.has(windowDays)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_window",
        detail: `windowDays must be one of: ${Array.from(ALLOWED_WINDOWS).join(", ")}`,
      });
    }

    let actorUid = "";
    let actorRole = null;
    try {
      ({ uid: actorUid } = await extractActorUid(req, req.query || {}));
      const gate = await assertActorRole(orgId, actorUid, ROLES_ADMIN_ONLY);
      actorRole = (gate.membership && gate.membership.role) || null;
    } catch (e) {
      return j(res, httpStatusFromAuthzError(e), {
        ok: false, error: (e && e.code) || "permission-denied",
      });
    }

    const db = getFirestore();
    const aggsRef = db.collection("orgs").doc(orgId).collection("recovery_aggregates");

    if (type === "recovery_metrics") {
      const snap = await aggsRef.doc(metricsDocId()).get();
      if (!snap.exists) {
        return j(res, 200, {
          ok: true, orgId, type, windowDays,
          summary: summarizeWindow({}, windowDays),
          lifetime: {},
        });
      }
      const data = snap.data() || {};
      return j(res, 200, {
        ok: true, orgId, type, windowDays,
        summary: summarizeWindow(data, windowDays),
        lifetime: data.lifetime || {},
      });
    }

    // cause_effectiveness or action_effectiveness — fan out across docs
    const prefix = type === "cause_effectiveness"
      ? "cause_effectiveness_"
      : "action_effectiveness_";

    // Use viewType field for the query (matches what _recoveryAggregators seeds).
    const viewType = type;
    const querySnap = await aggsRef.where("viewType", "==", viewType).get();

    const rows = [];
    for (const doc of querySnap.docs) {
      const data = doc.data() || {};
      const summary = summarizeWindow(data, windowDays);
      rows.push({
        docId: doc.id,
        ...(type === "cause_effectiveness" ? { causePrimary: data.causePrimary || null } : {}),
        ...(type === "action_effectiveness" ? { actionType: data.actionType || null } : {}),
        summary,
        lifetime: data.lifetime || {},
      });
    }

    // Sort largest-first by "totalCases" (cause) or "totalUses" (action)
    // within the window, so the most-active surfaces first.
    const sortKey = type === "cause_effectiveness" ? "totalCases" : "totalUses";
    rows.sort((a, b) => (Number(b.summary.metrics?.[sortKey]) || 0) - (Number(a.summary.metrics?.[sortKey]) || 0));

    console.log("[getRecoveryAggregatesV1] returned", {
      orgId, type, windowDays, rowCount: rows.length, actorUid, actorRole,
    });

    return j(res, 200, {
      ok: true, orgId, type, windowDays,
      rows,
    });
  } catch (e) {
    console.error("[getRecoveryAggregatesV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
