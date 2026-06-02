// PEAKOPS_CUSTOMER_REVIEW_LINK_V1 (PR 126a)
//
// Token-only callable that returns a sanitized read-only dossier for
// the linked incident. No auth — the token in the URL IS the credential.
//
// Inputs:
//   GET ?token=peakops_rv_...
//
// Outputs (200):
//   {
//     ok: true,
//     tokenHashPrefix,
//     status: "submitted_to_customer" | "customer_accepted" | "customer_rejected",
//     consumed: boolean,
//     consumedAction: null | "accepted" | "rejected",
//     review: {
//       customerLabel,
//       archetype,
//       templateKey,
//       templateVersion,
//       title,
//       location,
//       summary,
//       requirements: {
//         requiredProof: [{ label, description?, satisfied }],
//         optionalProof,
//         acceptanceCriteria
//       },
//       acceptanceChecks: [{ type, tier, label, description, satisfied, detail }],
//       readiness: { ready, label },
//       evidenceItems: [{ id, filename, caption, capturedAt, slotKey, gps }],
//       createdAt, submittedToCustomerAt,
//       coordinatorDisplayName
//     }
//   }
//
// Failure modes:
//   400 missing_token / malformed_token
//   404 token_not_found             (intentional — same shape as wrong-token-shape)
//   410 token_revoked | token_consumed_terminal
//   429 rate_limited
//
// Rate limiting: per-token sliding window via transactional update on
// the link doc itself (GET: 20/min). No external state required.
//
// IMPORTANT: this endpoint runs WITHOUT auth. Treat the token as the
// only secret. Never log the cleartext token.

require("./_emu_bootstrap");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { resolveIncidentRef } = require("./_incidentPath");
const { INCIDENT_STATUS, normalizeIncidentStatus } = require("./incidentState");
const {
  isWellFormed,
  hashToken,
  hashPrefix,
  ipPrefixFromRequest,
  userAgentFingerprint,
} = require("./_customerReviewToken");

if (!admin.apps.length) admin.initializeApp();

const GET_WINDOW_MS = 60 * 1000;
const GET_LIMIT_PER_WINDOW = 20;
const ACCESS_HARD_CAP = 500;          // Total lifetime — bounds runaway abuse.

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function tsIso(v) {
  return v?.toDate?.().toISOString?.() || v || null;
}

function trimStr(v) {
  return String(v == null ? "" : v).trim();
}

// Strip any internal/PII fields from an evidence record before returning.
function sanitizeEvidenceItem(d) {
  const data = d.data ? (d.data() || {}) : (d || {});
  return {
    id: String(d.id || data.id || ""),
    filename: trimStr(data.filename || data.fileName || data.name),
    caption: trimStr(data.caption || data.label),
    slotKey: trimStr(data.slotKey || data.requiredProofKey),
    capturedAt: tsIso(data.capturedAt || data.createdAt),
    gps: (data.gps && typeof data.gps === "object")
      ? {
        lat: Number(data.gps.lat) || null,
        lng: Number(data.gps.lng) || null,
        accuracyM: Number.isFinite(Number(data.gps.accuracyM)) ? Number(data.gps.accuracyM) : null,
      }
      : null,
  };
}

exports.getCustomerReviewV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") return j(res, 405, { ok: false, error: "Use GET" });

    const token = trimStr(req.query?.token);
    if (!token) return j(res, 400, { ok: false, error: "missing_token" });

    // Pre-DB shape check — cheap reject of obviously-malformed tokens
    // so bots can't spam Firestore reads with junk.
    if (!isWellFormed(token)) {
      // 404 (not 400) — same shape as wrong-token so attackers can't
      // distinguish "malformed" from "valid format but unknown".
      return j(res, 404, { ok: false, error: "token_not_found" });
    }

    const tokenHash = hashToken(token);
    const tokenHashPrefix = hashPrefix(token);

    const db = getFirestore();

    // Link docs live at `customer_review_links/{tokenHash}` (top-level)
    // so O(1) lookup without needing orgId in the URL. Multi-tenancy
    // is preserved by the `orgId` field on the doc.
    const linkRef = db.doc(`customer_review_links/${tokenHash}`);
    const linkSnap = await linkRef.get();
    if (!linkSnap.exists) {
      console.warn("[getCustomerReviewV1] token_not_found", { tokenHashPrefix });
      return j(res, 404, { ok: false, error: "token_not_found" });
    }
    const linkData = linkSnap.data() || {};

    // Revocation / consumption check before we record an access.
    if (linkData.revokedAt) {
      return j(res, 410, { ok: false, error: "token_revoked", tokenHashPrefix });
    }

    // Rate limiting + access counter — transactional so racing browsers
    // can't both slip under the limit on the same window.
    const now = Date.now();
    let isFirstAccess = false;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(linkRef);
        if (!snap.exists) {
          const err = new Error("token_not_found");
          err.statusCode = 404;
          throw err;
        }
        const data = snap.data() || {};

        // Re-check inside the txn — revocation may have happened mid-read.
        if (data.revokedAt) {
          const err = new Error("token_revoked");
          err.statusCode = 410;
          throw err;
        }

        const accessCount = Number(data.accessCount || 0);
        if (accessCount >= ACCESS_HARD_CAP) {
          const err = new Error("access_hard_cap_reached");
          err.statusCode = 429;
          throw err;
        }

        const recentAll = Array.isArray(data.recentGetTimestamps) ? data.recentGetTimestamps.slice() : [];
        const recent = recentAll.filter((t) => Number.isFinite(Number(t)) && (now - Number(t)) < GET_WINDOW_MS);
        if (recent.length >= GET_LIMIT_PER_WINDOW) {
          const err = new Error("rate_limited");
          err.statusCode = 429;
          throw err;
        }
        recent.push(now);
        // Keep the array bounded — never grow unboundedly.
        while (recent.length > GET_LIMIT_PER_WINDOW * 2) recent.shift();

        isFirstAccess = !data.firstAccessedAt;
        tx.update(linkRef, {
          recentGetTimestamps: recent,
          accessCount: accessCount + 1,
          lastAccessedAt: FieldValue.serverTimestamp(),
          ...(isFirstAccess ? { firstAccessedAt: FieldValue.serverTimestamp() } : {}),
        });
      });
    } catch (e) {
      const code = e?.statusCode || 500;
      const errStr = String(e?.message || "internal_error");
      return j(res, code, { ok: false, error: errStr, tokenHashPrefix });
    }

    // First-access audit — only fires once per token. After that, the
    // counter increments but we don't spam the audit log with re-reads.
    if (isFirstAccess) {
      try {
        await db
          .collection("orgs")
          .doc(linkData.orgId)
          .collection("customer_review_audit")
          .add({
            type: "customer_review_viewed",
            orgId: linkData.orgId,
            incidentId: linkData.incidentId,
            templateKey: linkData.templateKey || null,
            templateVersion: linkData.templateVersion || null,
            actorKind: "customer",
            tokenHashPrefix,
            userAgentFingerprint: userAgentFingerprint(req),
            ipPrefix: ipPrefixFromRequest(req),
            createdAt: FieldValue.serverTimestamp(),
          });
      } catch (e) {
        console.error("[getCustomerReviewV1] audit write failed", e && e.message);
      }
    }

    // Build the sanitized dossier.
    const { ref: incRef, exists: incExists } = await resolveIncidentRef(linkData.orgId, linkData.incidentId);
    if (!incExists) {
      // Pathologic case: link exists but incident gone (deleted out
      // of band). Treat as 404 so customer doesn't see a partial.
      return j(res, 404, { ok: false, error: "incident_not_found", tokenHashPrefix });
    }
    const incSnap = await incRef.get();
    const incData = incSnap.data() || {};
    const requirements = (incData.requirements && typeof incData.requirements === "object") ? incData.requirements : {};

    // Readiness cache — same source the Records / Summary surfaces use.
    const readinessCache = (incData.readinessCache && typeof incData.readinessCache === "object")
      ? incData.readinessCache
      : null;

    // Evidence list — read directly from the canonical subcollection.
    let evidenceItems = [];
    try {
      const evSnap = await incRef.collection("evidence_locker").limit(200).get();
      evidenceItems = evSnap.docs.map((d) => sanitizeEvidenceItem(d));
    } catch (e) {
      // Fall back to the top-level legacy path if it exists.
      try {
        const evSnap = await db
          .collection("incidents").doc(linkData.incidentId)
          .collection("evidence_locker").limit(200).get();
        evidenceItems = evSnap.docs.map((d) => sanitizeEvidenceItem(d));
      } catch (_e) { /* ignore */ }
    }

    const currentStatus = normalizeIncidentStatus(incData.status);
    const consumed = !!linkData.consumedAt;
    const consumedAction = trimStr(linkData.consumedAction) || null;

    const review = {
      // Provenance — Customer sees the template name + version they
      // were promised. This is the audit anchor across the boundary.
      customerLabel: trimStr(linkData.customerLabel) || trimStr(requirements.customerLabel) || trimStr(incData.customer),
      archetype: trimStr(linkData.archetype) || trimStr(requirements.archetype) || trimStr(incData.archetype),
      templateKey: trimStr(linkData.templateKey) || trimStr(requirements.templateKey),
      templateVersion: Number.isFinite(Number(linkData.templateVersion))
        ? Number(linkData.templateVersion)
        : (Number.isFinite(Number(requirements.templateVersion)) ? Number(requirements.templateVersion) : null),

      // Surface fields — same data Summary shows operator-side.
      title: trimStr(incData.title || incData.name),
      location: trimStr(incData.location || incData.address || incData.siteAddress),
      summary: trimStr(incData.summary || incData.description),

      requirements: {
        requiredProof: Array.isArray(requirements.requiredProof)
          ? requirements.requiredProof.map((label, i) => ({
            label: trimStr(label),
            description: trimStr(Array.isArray(requirements.requiredProofDescriptions)
              ? requirements.requiredProofDescriptions[i]
              : ""),
          }))
          : [],
        optionalProof: Array.isArray(requirements.optionalProof)
          ? requirements.optionalProof.map(trimStr).filter(Boolean)
          : [],
        acceptanceCriteria: Array.isArray(requirements.acceptanceCriteria)
          ? requirements.acceptanceCriteria.map(trimStr).filter(Boolean)
          : [],
      },

      acceptanceChecks: Array.isArray(requirements.acceptanceChecks)
        ? requirements.acceptanceChecks.map((c) => ({
          type: trimStr(c && c.type),
          tier: (c && c.tier === "required") ? "required" : "encouraged",
          label: trimStr(c && c.label),
          description: trimStr(c && c.description),
        }))
        : [],

      readiness: readinessCache
        ? {
          ready: Boolean(readinessCache.ready),
          label: trimStr(readinessCache.label) || (readinessCache.ready ? "Ready" : "Pending"),
          checks: Array.isArray(readinessCache.checks) ? readinessCache.checks : [],
        }
        : { ready: false, label: "Not computed", checks: [] },

      evidenceItems,

      createdAt: tsIso(linkData.createdAt),
      submittedToCustomerAt: tsIso(incData.submittedToCustomerAt),
      coordinatorDisplayName: trimStr(incData.submittedToCustomerByName) || trimStr(incData.createdByName),
    };

    return j(res, 200, {
      ok: true,
      tokenHashPrefix,
      status: currentStatus,
      consumed,
      consumedAction,
      review,
    });
  } catch (e) {
    console.error("[getCustomerReviewV1] unhandled", { error: String(e?.message || e), stack: e?.stack });
    return j(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
