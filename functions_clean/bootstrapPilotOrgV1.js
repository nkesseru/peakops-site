// PEAKOPS_BOOTSTRAP_PILOT_ORG_V1 (2026-05-06)
//
// Slice 14: production-safe org bootstrap. Closes the chicken-and-egg
// gap between Slice 8's default-deny rules and the "first member doc
// of a new customer org" problem. Without this callable, the only
// way to create the first org for a real customer is to hand-edit
// Firestore — which doesn't scale, isn't auditable, and risks
// orphan-org / orphan-member states.
//
// Atomic contract (the whole reason this is a single callable):
//   - Both `orgs/{orgId}` AND `orgs/{orgId}/members/{ownerUid}` land
//     together, or neither. A WriteBatch enforces this.
//   - The owner member is created with role="owner", status="active",
//     so the new owner can immediately read every org-scoped surface
//     under the new rules.
//   - The org doc is born with the foundation fields the rest of the
//     codebase expects: kind="customer", status="active", orgType,
//     industry, timezone, industryProfileVersion, ownerUserId.
//   - An audit-log entry at orgs/{orgId}/audit/bootstrap_<ts> records
//     who ran the bootstrap and against which inputs.
//
// Auth gate (internal-staff-only):
//   - Production: caller must hold a verified Firebase ID token whose
//     custom claim `peakopsInternalAdmin === true`. Mint that claim
//     via the existing setClaims tooling at the parent project root
//     (setClaims.cjs / setClaims.mjs). Without it, the call fails
//     closed with permission-denied.
//   - Emulator (FIRESTORE_EMULATOR_HOST set): the gate accepts ANY
//     authenticated caller — production can never reach this branch
//     because production firebase-admin doesn't carry that env var.
//     This lets the emulator smoke run without first having to mint
//     a peakopsInternalAdmin claim against a fake Auth Emulator user.
//
// Idempotency:
//   - If the org already exists AND the owner member already exists,
//     the call returns 200 with `already: true`. Safe to retry.
//   - If the org exists but the owner member is missing (mid-failure
//     state), the call writes the missing member and returns
//     `repaired: true`. Useful for recovering a partially-applied
//     bootstrap from a prior failure.
//   - If the owner member exists with a DIFFERENT uid than requested,
//     the call refuses with 409 "owner_uid_mismatch". Never overwrites
//     an existing owner.
//   - --force semantics are deliberately absent. Re-bootstrapping an
//     existing org is never the right move; explicit support tooling
//     handles cleanup if a wrong org id was provisioned.
//
// What this does NOT do:
//   - Send any invite email. The owner gets their magic link via the
//     normal /login flow (email matched to ownerUid).
//   - Mint custom claims. Slice 14 leaves claim minting to the
//     existing setClaims tooling at the project root.
//   - Create vendors, workflows, or first jobs. Onboarding's job, not
//     bootstrap's.

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { httpStatusFromAuthzError } = require("./_authz");
const { extractActorUid } = require("./_actor");
const { HttpsError } = require("firebase-functions/v2/https");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function emulatorMode() {
  return Boolean(
    String(process.env.FIRESTORE_EMULATOR_HOST || "").trim() ||
      String(process.env.FIREBASE_AUTH_EMULATOR_HOST || "").trim(),
  );
}

const VALID_ORG_TYPES = new Set(["operator", "vendor", "hybrid"]);
const VALID_INDUSTRIES = new Set([
  "utilities",
  "telecom",
  "municipality",
  "contractor",
  "other",
]);
const INDUSTRY_PROFILE_VERSION = "v1.0";

exports.bootstrapPilotOrgV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return j(res, 405, { ok: false, error: "POST required" });
    }
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    // ── Input validation ──
    const orgId = mustStr(body.orgId, "orgId");
    const orgName = mustStr(body.orgName, "orgName");
    const ownerUid = mustStr(body.ownerUid, "ownerUid");
    const ownerEmail = String(body.ownerEmail || "").trim().toLowerCase();
    const orgType = String(body.orgType || "operator").trim().toLowerCase();
    const industry = String(body.industry || "other").trim().toLowerCase();
    const timezone = String(body.timezone || "UTC").trim();

    if (!VALID_ORG_TYPES.has(orgType)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_orgType",
        detail: `orgType must be one of: ${Array.from(VALID_ORG_TYPES).join(", ")}`,
      });
    }
    if (!VALID_INDUSTRIES.has(industry)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_industry",
        detail: `industry must be one of: ${Array.from(VALID_INDUSTRIES).join(", ")}`,
      });
    }
    if (orgId === "demo-org") {
      // Hard-block re-bootstrapping demo-org through this path. demo-org
      // has its own seed flow; routing it through pilot-bootstrap would
      // mark it kind="customer" and cross the demo↔customer barrier.
      return j(res, 403, { ok: false, error: "demo_org_not_allowed" });
    }

    // ── Caller auth ──
    let callerUid = "";
    let callerClaims = null;
    try {
      const out = await extractActorUid(req, body);
      callerUid = String(out.uid || "").trim();
      callerClaims = out.claims || null;
    } catch (e) {
      console.warn("[bootstrapPilotOrgV1] actor_extract_failed", { msg: String(e && e.message) });
    }

    // Internal-admin gate. Emulator accepts any caller; production
    // requires the verified custom claim.
    const isEmu = emulatorMode();
    const hasInternalClaim =
      !!callerClaims && callerClaims.peakopsInternalAdmin === true;
    if (!isEmu && !hasInternalClaim) {
      console.warn("[bootstrapPilotOrgV1] authz_denied", {
        fn: "bootstrapPilotOrgV1",
        orgId,
        ownerUid,
        callerUid,
        reason: "internal_admin_required",
      });
      const e = new HttpsError("permission-denied", "[bootstrapPilotOrgV1] internal admin required");
      return j(res, httpStatusFromAuthzError(e), {
        ok: false,
        error: "permission-denied",
      });
    }
    if (!callerUid) {
      // Even in emulator mode we want SOMEONE in the audit log. Fall
      // back to a well-known marker.
      callerUid = isEmu ? "emulator-self-test" : "unknown";
    }

    console.log("[bootstrapPilotOrgV1] authz_ok", {
      fn: "bootstrapPilotOrgV1",
      orgId,
      ownerUid,
      callerUid,
      mode: isEmu ? "emulator" : "production",
    });

    const db = getFirestore();

    const orgRef = db.doc(`orgs/${orgId}`);
    const ownerMemberRef = db.doc(`orgs/${orgId}/members/${ownerUid}`);

    // ── Idempotency check ──
    const [orgSnap, ownerSnap] = await Promise.all([
      orgRef.get(),
      ownerMemberRef.get(),
    ]);

    if (orgSnap.exists && ownerSnap.exists) {
      const ownerData = ownerSnap.data() || {};
      const ownerStatus = String(ownerData.status || "active").toLowerCase();
      const ownerRole = String(ownerData.role || "").toLowerCase();
      if (ownerStatus === "active" && (ownerRole === "owner" || ownerRole === "admin")) {
        console.log("[bootstrapPilotOrgV1] already_bootstrapped", {
          orgId,
          ownerUid,
          ownerRole,
        });
        return j(res, 200, {
          ok: true,
          orgId,
          ownerUid,
          already: true,
          ownerRole,
        });
      }
    }

    if (orgSnap.exists && !ownerSnap.exists) {
      // Repair path: org exists but owner member is missing. This can
      // only happen if a prior bootstrap failed mid-batch (rare; the
      // batch below is supposed to be all-or-nothing). Repair safely.
      console.warn("[bootstrapPilotOrgV1] repair_missing_owner_member", { orgId, ownerUid });
    }

    // Refuse if a different owner member already exists.
    if (orgSnap.exists) {
      const existingOwnerUid = String((orgSnap.data() || {}).ownerUserId || "").trim();
      if (existingOwnerUid && existingOwnerUid !== ownerUid) {
        return j(res, 409, {
          ok: false,
          error: "owner_uid_mismatch",
          detail: `org already has ownerUserId=${existingOwnerUid}; refusing to overwrite`,
        });
      }
    }

    // ── Atomic batched write ──
    const now = FieldValue.serverTimestamp();
    const batch = db.batch();

    const orgDoc = {
      orgId,
      name: orgName,
      orgType,
      kind: "customer",
      status: "active",
      industry,
      industryProfileVersion: INDUSTRY_PROFILE_VERSION,
      timezone,
      ownerUserId: ownerUid,
      memberCount: 1,
      activeRelationshipCount: 0,
      bootstrappedAt: now,
      bootstrappedBy: callerUid,
      createdAt: orgSnap.exists ? (orgSnap.data() || {}).createdAt || now : now,
      updatedAt: now,
    };
    batch.set(orgRef, orgDoc, { merge: true });

    const memberDoc = {
      uid: ownerUid,
      orgId,
      role: "owner",
      status: "active",
      email: ownerEmail || null,
      source: "bootstrap-pilot",
      invitedBy: callerUid,
      invitedAt: now,
      joinedAt: now,
      // Default per-feature permissions for owner. These mirror the
      // architecture model § 3 owner role: full access.
      permissions: {
        incidents:    { create: true, assign: true, close: true },
        workflows:    { edit: true },
        members:      { invite: true, manage: true },
        relationships:{ manage: true },
        billing:      { view: true, manage: true },
      },
      createdAt: now,
      updatedAt: now,
    };
    batch.set(ownerMemberRef, memberDoc, { merge: true });

    // Audit-log entry. Lives at orgs/{orgId}/audit/{eventId} — same
    // pattern the relationship slice will use later, just inside the
    // org's own audit subcollection.
    const auditId = `bootstrap_${Date.now()}`;
    const auditRef = db.doc(`orgs/${orgId}/audit/${auditId}`);
    batch.set(auditRef, {
      id: auditId,
      type: "ORG_BOOTSTRAPPED",
      orgId,
      ownerUid,
      ownerEmail: ownerEmail || null,
      orgType,
      industry,
      timezone,
      callerUid,
      mode: isEmu ? "emulator" : "production",
      occurredAt: now,
    });

    await batch.commit();

    return j(res, 200, {
      ok: true,
      orgId,
      ownerUid,
      ownerRole: "owner",
      bootstrappedAt: new Date().toISOString(),
      repaired: orgSnap.exists && !ownerSnap.exists,
    });
  } catch (e) {
    console.error("[bootstrapPilotOrgV1] failed", { msg: String(e && e.message || e) });
    return j(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});
