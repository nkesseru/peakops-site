// PEAKOPS_RECOVERY_LIST_V1 (PR 127a2)
//
// Admin/coordinator-only callable that returns the operator queue
// for Recovery Cases. Per PR 127a2 planning:
//   - All filtering is client-side (small MVP dataset)
//   - Priority is system-derived on every read (PR 127a2 #1 + override)
//   - Returns a lightweight summary projection per case — counts only,
//     not full action lists or audit. The detail callable
//     (getRecoveryCaseV1) is the place for those.
//
// Sorted server-side by openedAt-desc so newest cases surface first.
// UI can re-sort client-side; this is just the natural read order.

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const {
  assertActorRole,
  httpStatusFromAuthzError,
  ROLES_ADMIN_ONLY,
} = require("./_authz");
const { extractActorUid } = require("./_actor");
const { derivePriority, daysOpenSince } = require("./_recoveryPriority");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function tsIso(v) {
  return v?.toDate?.().toISOString?.() || v || null;
}

function trimStr(v) {
  return String(v == null ? "" : v).trim();
}

exports.listRecoveryCasesV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "Use GET" });

    const orgId = trimStr(req.query?.orgId);
    if (!orgId) return j(res, 400, { ok: false, error: "Missing orgId" });

    // Authz — admin/owner only.
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
    const snap = await db
      .collection("orgs").doc(orgId)
      .collection("recovery_cases")
      .orderBy("openedAt", "desc")
      .limit(500)                              // sanity cap; expected ≪ this
      .get()
      .catch((e) => {
        // Empty collection or missing index → fall back to unsorted read.
        console.warn("[listRecoveryCasesV1] orderBy fallback", e && e.message);
        return null;
      });

    let docs = [];
    if (snap && !snap.empty) {
      docs = snap.docs;
    } else {
      const fallback = await db
        .collection("orgs").doc(orgId)
        .collection("recovery_cases")
        .limit(500)
        .get();
      docs = fallback.docs;
    }

    const now = new Date();
    // PR 127c-a — batch-fetch incident docs for jobTitle / jobLocation
    // denorm. Done once outside the map() so we have one Firestore read
    // per unique incidentId rather than per-case.
    const incidentIds = Array.from(new Set(
      docs.map((d) => trimStr(d.data()?.incidentId)).filter(Boolean)
    ));
    const incidentLookup = new Map();
    await Promise.all(incidentIds.map(async (incidentId) => {
      try {
        const canonicalRef = db.collection("orgs").doc(orgId)
          .collection("incidents").doc(incidentId);
        let snap = await canonicalRef.get();
        if (!snap.exists) {
          snap = await db.collection("incidents").doc(incidentId).get();
        }
        if (snap.exists) {
          const incData = snap.data() || {};
          incidentLookup.set(incidentId, {
            jobTitle: trimStr(incData.title || incData.name),
            jobLocation: trimStr(incData.location || incData.address || incData.siteAddress),
          });
        }
      } catch (e) {
        console.warn("[listRecoveryCasesV1] incident denorm failed", incidentId, e && e.message);
      }
    }));

    const cases = docs.map((d) => {
      const data = d.data() || {};
      const amount = Number(data.revenueAtRisk?.amount);
      const amountType = trimStr(data.revenueAtRisk?.type) || "unknown";
      const daysOpen = daysOpenSince(data.openedAt, now);
      const derivedPriority = derivePriority({ amount, daysOpen, amountType });
      const incidentId = trimStr(data.incidentId);
      const inc = incidentLookup.get(incidentId) || { jobTitle: "", jobLocation: "" };

      return {
        // Identity
        caseId: d.id,
        incidentId,

        // PR 127c-a — denormed from incident doc for queue display.
        jobTitle: inc.jobTitle,
        jobLocation: inc.jobLocation,

        // Display fields
        title: trimStr(data.title),             // (denorm not stored; UI joins with incident if needed)
        templateKey: trimStr(data.templateKey),
        templateVersion: Number.isFinite(Number(data.templateVersion)) ? Number(data.templateVersion) : null,

        // Status / lifecycle
        status: trimStr(data.status) || "open",
        // PR 127a2 — derived priority replaces persisted value at display time.
        // The persisted data.priority field is informational/legacy only.
        priority: derivedPriority,

        // Revenue
        revenueAtRisk: {
          amount: Number.isFinite(amount) ? amount : 0,
          currency: trimStr(data.revenueAtRisk?.currency) || "USD",
          type: amountType,
        },

        // Cause snapshot (primary + customer comment for the row preview)
        cause: {
          primary: trimStr(data.cause?.primary),
          customerComment: trimStr(data.cause?.customerComment),
        },

        // Ownership snapshot
        owner: trimStr(data.ownership?.owner),
        ownerRole: trimStr(data.ownership?.ownerRole),

        // Aging + cycle counters
        daysOpen,
        cycleCount: Number.isFinite(Number(data.cycleCount)) ? Number(data.cycleCount) : 0,

        // Timestamps
        openedAt: tsIso(data.openedAt),
        updatedAt: tsIso(data.updatedAt),
        resolvedAt: tsIso(data.resolvedAt),

        // Resolution (if terminal)
        resolutionOutcome: trimStr(data.resolution?.outcome),
      };
    });

    console.log("[listRecoveryCasesV1] returned", {
      orgId, count: cases.length, actorUid, actorRole,
    });

    return j(res, 200, {
      ok: true,
      orgId,
      cases,
      // Aggregate totals for UI header strip (computed server-side once).
      totals: {
        cases: cases.length,
        openCases: cases.filter((c) => !["recovered", "partial_recovery", "abandoned", "expired"].includes(c.status)).length,
        openRevenue: cases
          .filter((c) => !["recovered", "partial_recovery", "abandoned", "expired"].includes(c.status))
          .reduce((sum, c) => sum + (Number(c.revenueAtRisk.amount) || 0), 0),
      },
    });
  } catch (e) {
    console.error("[listRecoveryCasesV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
