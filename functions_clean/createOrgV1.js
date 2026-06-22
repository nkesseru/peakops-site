// PEAKOPS_CREATE_ORG_V1 (Chunk 3B-1, 2026-06-22)
//
// One-call provisioning for a new customer organization. Replaces the
// 5-step manual founder dance documented in
// docs/checkpoints/chunk1-trust-foundation.md (Chunk 3A audit):
//
//   Before (manual founder CLI sequence):
//     1. node setInternalAdminClaim.cjs --target-email=… --apply
//     2. Create Firebase Auth user for customer admin in Console
//     3. curl POST /bootstrapPilotOrgV1 with ownerUid
//     4. node setClaims.cjs <uid> <orgId> owner --apply
//     5. Email customer admin their first-login URL by hand
//
//   After (this callable):
//     POST /createOrgV1 { orgName, industry, ownerEmail, … }
//        → atomic: find-or-create Auth user, mint claims,
//                  bootstrap org, write owner member, audit row,
//                  return first-login magic link.
//
// Auth gate: same as bootstrapPilotOrgV1 — Firebase ID token with the
// `peakopsInternalAdmin === true` custom claim. Production-locked
// until a future PR exposes this via a CS-grade /admin UI.
//
// Idempotency: if an org with the slugified orgId already exists,
// return { already: true } with the existing orgId + ownerUid. Never
// overwrites an existing org. If you need to fix a botched bootstrap,
// use bootstrapPilotOrgV1's repair path.
//
// What this does NOT do (deferred to follow-on chunks):
//   - It does NOT seed templates (Chunk 3B-2: starter-template seed)
//   - It does NOT brand the packet (Chunk 3B-3: packet branding)
//   - It does NOT send a welcome email (relies on caller / CS person
//     to deliver the returned magic link)
//   - It does NOT support multi-org users on first-call (orgIds claim
//     is set to [orgId] for a fresh user; existing claims are merged
//     to preserve peakopsInternalAdmin etc.)

const { onRequest } = require("firebase-functions/v2/https");
const { HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { httpStatusFromAuthzError } = require("./_authz");
const { extractActorUid } = require("./_actor");
const { toCustomerSlug } = require("./_customerSlug");

if (!admin.apps.length) admin.initializeApp();

function j(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

function mustStr(v, name) {
  const s = String(v || "").trim();
  if (!s) throw new Error(`${name} required`);
  return s;
}

function isEmailShape(v) {
  const s = String(v == null ? "" : v).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function emulatorMode() {
  return Boolean(
    String(process.env.FIRESTORE_EMULATOR_HOST || "").trim() ||
      String(process.env.FIREBASE_AUTH_EMULATOR_HOST || "").trim(),
  );
}

const VALID_INDUSTRIES = new Set([
  "utilities",
  "telecom",
  "municipality",
  "contractor",
  "other",
]);
const INDUSTRY_PROFILE_VERSION = "v1.0";
const DEFAULT_ORG_TYPE = "operator";

// PEAKOPS_CREATE_ORG_V1 — orgId derivation. The customer's free-text
// orgName is run through the same slug helper used elsewhere in the
// codebase (toCustomerSlug). If the slugified result is empty (e.g.
// only emoji input) we reject; we never auto-coin a random orgId
// without operator approval.
function deriveOrgId(orgName) {
  const slug = toCustomerSlug(orgName);
  if (!slug) return "";
  // Cap length defensively — Firestore doc IDs have a 1500-byte hard
  // limit but >64 chars is awful for ops. Keep slugs human-typable.
  return slug.slice(0, 64);
}

function buildActionCodeSettings(req) {
  // PEAKOPS_PROD_ORIGIN_PRIORITY_V1 (Chunk 3B-1 follow-up, 2026-06-22)
  //
  // Prefer the explicit PEAKOPS_APP_ORIGIN env var over any request-
  // derived host. Required because direct-to-function-URL callers
  // (e.g. scripts/activateCustomerOrg.cjs hitting the Cloud Run host)
  // would otherwise see `req.headers.host` equal to the function's own
  // Cloud Run hostname (e.g. "createorgv1-…-uc.a.run.app"), which is
  // NOT in Firebase Auth's Authorized Domains list and produces
  // `auth/unauthorized-continue-uri: "Domain not allowlisted by project"`
  // when generatePasswordResetLink is called below.
  //
  // The fallback chain (env var → x-forwarded-host → req.headers.host →
  // hardcoded default) keeps emulator + proxy-routed traffic working
  // when the env var isn't set. In production the env var is set via
  // functions_clean/.env.peakops-pilot (PEAKOPS_APP_ORIGIN=https://app.peakops.app).
  const envOrigin = String(process.env.PEAKOPS_APP_ORIGIN || "").trim();
  if (envOrigin) {
    const cleaned = envOrigin.replace(/\/+$/, "");
    return { url: `${cleaned}/auth/action`, handleCodeInApp: true };
  }
  const xfp = String(req.headers["x-forwarded-proto"] || "https");
  const xfh = String(req.headers["x-forwarded-host"] || req.headers.host || "");
  let origin = "";
  if (xfh) {
    origin = `${xfp}://${xfh}`;
  } else {
    origin = "https://app.peakops.app";
  }
  origin = origin.replace(/\/+$/, "");
  return {
    url: `${origin}/auth/action`,
    handleCodeInApp: true,
  };
}

// Find an Auth user by email if it exists; otherwise create a new
// one. Returns { uid, created: boolean }. Throws on any error other
// than the expected user-not-found case.
async function findOrCreateAuthUser({ ownerEmail, ownerName }) {
  try {
    const u = await admin.auth().getUserByEmail(ownerEmail);
    return { uid: u.uid, created: false };
  } catch (e) {
    const code = String((e && e.code) || "").toLowerCase();
    if (!code.includes("user-not-found")) {
      throw e;
    }
  }
  // Create. emailVerified is false until the customer goes through
  // the magic-link flow. displayName is best-effort: a missing name
  // is fine, Firebase Auth will show the email instead.
  const created = await admin.auth().createUser({
    email: ownerEmail,
    emailVerified: false,
    disabled: false,
    ...(ownerName ? { displayName: ownerName } : {}),
  });
  return { uid: created.uid, created: true };
}

// PEAKOPS_STARTER_TEMPLATES_V1 (Chunk 3B-2, 2026-06-22)
//
// Per-industry starter template content. Seeded into a brand-new
// org's templates subcollection at provisioning time so the first
// incident doesn't render with a bare archetype proof checklist.
// Operators can override by writing their own template later via
// /admin/templates; the starter is never overwritten (see
// seedStarterTemplate below).
//
// Telecom is the only industry with a real starter template in this
// chunk. Other industries are placeholders that get skipped — the
// operator authors templates manually via the admin UI until the
// next chunk adds their starters. Single industry done well >
// five industries done shallowly.
//
// Schema mirrors orgs/{orgId}/templates/{archetype} written by
// seedCustomerTemplate.cjs / saveOrgTemplateV1: archetype,
// requiredProof[], optionalProof[], acceptanceCriteria[],
// acceptanceChecks[], version, label, updatedBy.
const STARTER_TEMPLATES_BY_INDUSTRY = Object.freeze({
  telecom: {
    docId: "fiber_splice_verification",
    data: Object.freeze({
      archetype: "fiber_splice_verification",
      label: "Fiber splice verification (starter)",
      requiredProof: Object.freeze([
        "Site arrival photo",
        "Splice enclosure — before photo",
        "Splice enclosure — after photo",
        "Equipment / fiber label photo",
        "GPS-tagged completion photo",
      ]),
      optionalProof: Object.freeze([
        "Splice tray close-up",
        "OTDR trace screenshot",
        "Loss-reading printout",
      ]),
      acceptanceCriteria: Object.freeze([
        "All required photos uploaded and GPS-tagged",
        "Supervisor approval recorded",
        "Field notes captured",
      ]),
      // Drives _readiness.js deterministic checks. tier="required"
      // gates packet readiness; "encouraged" surfaces a soft signal
      // without blocking.
      acceptanceChecks: Object.freeze([
        { type: "requires_minimum_proof_count", tier: "required", params: { minCount: 4 } },
        { type: "requires_supervisor_approval", tier: "required" },
        { type: "requires_at_least_one_gps_proof", tier: "required" },
        { type: "requires_field_notes", tier: "encouraged" },
        { type: "requires_incident_closure", tier: "required" },
      ]),
      version: 1,
      updatedBy: "createOrgV1:starter-template",
    }),
  },
});

// PEAKOPS_STARTER_TEMPLATES_V1 (Chunk 3B-2)
// Idempotent best-effort seed. Writes the industry-specific starter
// template at orgs/{orgId}/templates/{docId} IFF no template doc
// exists at that path. Never overwrites operator-authored content.
// Never blocks org creation — wrap caller in try/catch.
async function seedStarterTemplate(db, orgId, industry) {
  const starter = STARTER_TEMPLATES_BY_INDUSTRY[industry];
  if (!starter) {
    console.log(`[createOrgV1] starter_template_skipped`, {
      orgId, industry, reason: "no_starter_defined_for_industry",
    });
    return { seeded: false, reason: "no_starter_defined_for_industry" };
  }
  const templateRef = db.doc(`orgs/${orgId}/templates/${starter.docId}`);
  const existing = await templateRef.get();
  if (existing.exists) {
    console.log(`[createOrgV1] starter_template_skipped`, {
      orgId, industry, reason: "template_already_exists",
      templateKey: starter.docId,
    });
    return { seeded: false, reason: "template_already_exists" };
  }
  await templateRef.set({
    ...starter.data,
    // Materialize the frozen arrays as plain JS arrays for the write.
    requiredProof: [...starter.data.requiredProof],
    optionalProof: [...starter.data.optionalProof],
    acceptanceCriteria: [...starter.data.acceptanceCriteria],
    acceptanceChecks: starter.data.acceptanceChecks.map((c) => ({ ...c })),
    seededAt: FieldValue.serverTimestamp(),
    seededBy: "createOrgV1:starter-template",
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log(`[createOrgV1] starter_template_seeded`, {
    orgId, industry, templateKey: starter.docId,
  });
  return { seeded: true, templateKey: starter.docId };
}

// Merge orgId, role, and orgIds=[orgId] onto the user's existing
// custom claims. Preserves peakopsInternalAdmin and anything else
// already set.
async function mintOwnerClaims(uid, orgId) {
  let existing = {};
  try {
    const u = await admin.auth().getUser(uid);
    existing = u.customClaims || {};
  } catch (_e) { /* fresh user — empty claims */ }
  // PEAKOPS_CREATE_ORG_V1 — new-org claim shape mirrors setClaims.cjs.
  // For an org-creation flow the owner ONLY belongs to the new org
  // initially, so orgIds=[orgId] is correct. Multi-org membership
  // happens through inviteOrgMemberV1 (which appends, not replaces).
  const next = {
    ...existing,
    orgId,
    role: "owner",
    orgIds: [orgId],
  };
  await admin.auth().setCustomUserClaims(uid, next);
  return { before: existing, after: next };
}

exports.createOrgV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    if (req.method !== "POST") {
      return j(res, 405, { ok: false, error: "POST required" });
    }
    const body = (typeof req.body === "object" && req.body) ? req.body : {};

    // ── Input validation ──────────────────────────────────────────
    let orgName;
    let ownerEmail;
    try {
      orgName = mustStr(body.orgName, "orgName");
      ownerEmail = mustStr(body.ownerEmail, "ownerEmail").toLowerCase();
    } catch (e) {
      return j(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
    if (!isEmailShape(ownerEmail)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_ownerEmail",
        detail: "ownerEmail must be a valid email address",
      });
    }
    const ownerName = String(body.ownerName || "").trim();
    const industry = String(body.industry || "other").trim().toLowerCase();
    const timezone = String(body.timezone || "UTC").trim();
    const orgType = String(body.orgType || DEFAULT_ORG_TYPE).trim().toLowerCase();

    if (!VALID_INDUSTRIES.has(industry)) {
      return j(res, 400, {
        ok: false,
        error: "invalid_industry",
        detail: `industry must be one of: ${Array.from(VALID_INDUSTRIES).join(", ")}`,
      });
    }

    const orgId = deriveOrgId(orgName);
    if (!orgId) {
      return j(res, 400, {
        ok: false,
        error: "orgName_unsluggable",
        detail: "orgName produced an empty slug (no [a-z0-9] characters after normalization)",
      });
    }
    // Hard-block names that collide with reserved org IDs.
    if (orgId === "demo-org" || orgId.startsWith("demo-")) {
      return j(res, 403, {
        ok: false,
        error: "reserved_orgId_prefix",
        detail: `orgId "${orgId}" uses a reserved demo- prefix`,
      });
    }

    // ── Caller auth ───────────────────────────────────────────────
    let callerUid = "";
    let callerClaims = null;
    try {
      const out = await extractActorUid(req, body);
      callerUid = String(out.uid || "").trim();
      callerClaims = out.claims || null;
    } catch (e) {
      console.warn("[createOrgV1] actor_extract_failed", { msg: String(e && e.message) });
    }

    const isEmu = emulatorMode();
    const hasInternalClaim =
      !!callerClaims && callerClaims.peakopsInternalAdmin === true;
    if (!isEmu && !hasInternalClaim) {
      console.warn("[createOrgV1] authz_denied", {
        fn: "createOrgV1",
        orgName,
        ownerEmail,
        callerUid,
        reason: "internal_admin_required",
      });
      const e = new HttpsError("permission-denied", "[createOrgV1] internal admin required");
      return j(res, httpStatusFromAuthzError(e), { ok: false, error: "permission-denied" });
    }
    if (!callerUid) {
      callerUid = isEmu ? "emulator-self-test" : "unknown";
    }

    console.log("[createOrgV1] authz_ok", {
      fn: "createOrgV1",
      orgId,
      ownerEmail,
      callerUid,
      mode: isEmu ? "emulator" : "production",
    });

    const db = getFirestore();

    // ── Idempotency: org already exists? ─────────────────────────
    const orgRef = db.doc(`orgs/${orgId}`);
    const orgSnap = await orgRef.get();
    if (orgSnap.exists) {
      const existing = orgSnap.data() || {};
      const existingOwnerUid = String(existing.ownerUserId || "").trim();
      console.log("[createOrgV1] already_exists", { orgId, existingOwnerUid });
      return j(res, 200, {
        ok: true,
        orgId,
        ownerUid: existingOwnerUid || null,
        already: true,
        detail: "org already provisioned; no changes made",
      });
    }

    // ── Find-or-create Auth user ─────────────────────────────────
    let authResult;
    try {
      authResult = await findOrCreateAuthUser({ ownerEmail, ownerName });
    } catch (e) {
      console.error("[createOrgV1] auth_user_failed", {
        orgId, ownerEmail, msg: String(e && e.message || e),
      });
      return j(res, 502, {
        ok: false,
        error: "auth_user_provision_failed",
        detail: String((e && e.message) || e),
      });
    }
    const ownerUid = authResult.uid;

    // ── Mint custom claims ───────────────────────────────────────
    try {
      await mintOwnerClaims(ownerUid, orgId);
    } catch (e) {
      console.error("[createOrgV1] claims_failed", {
        orgId, ownerUid, msg: String(e && e.message || e),
      });
      // The Auth user has been created but claims failed — that's an
      // inconsistent state. We surface it loudly so the caller knows
      // to either retry (idempotent) or hand-fix via setClaims.cjs.
      return j(res, 502, {
        ok: false,
        error: "claims_mint_failed",
        detail: String((e && e.message) || e),
        orgId,
        ownerUid,
      });
    }

    // ── Generate the first-login magic link ──────────────────────
    let firstLoginUrl = "";
    try {
      const acs = buildActionCodeSettings(req);
      firstLoginUrl = await admin
        .auth()
        .generatePasswordResetLink(ownerEmail, acs);
    } catch (e) {
      // Magic-link generation is best-effort. If it fails (rare), the
      // bootstrap still succeeds; the caller can hand-deliver a reset
      // link via the Firebase Console or a separate teamRecoveryV1 call.
      console.warn("[createOrgV1] magic_link_failed", {
        orgId, ownerUid, msg: String(e && e.message || e),
      });
    }

    // ── Atomic org + owner-member + audit batch ──────────────────
    const now = FieldValue.serverTimestamp();
    const batch = db.batch();
    const ownerMemberRef = db.doc(`orgs/${orgId}/members/${ownerUid}`);
    const auditId = `create_org_${Date.now()}`;
    const auditRef = db.doc(`orgs/${orgId}/audit/${auditId}`);

    batch.set(orgRef, {
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
      createdAt: now,
      updatedAt: now,
    });

    batch.set(ownerMemberRef, {
      uid: ownerUid,
      orgId,
      role: "owner",
      status: "active",
      email: ownerEmail,
      displayName: ownerName || null,
      source: "create-org-v1",
      invitedBy: callerUid,
      invitedAt: now,
      joinedAt: now,
      permissions: {
        incidents:    { create: true, assign: true, close: true },
        workflows:    { edit: true },
        members:      { invite: true, manage: true },
        relationships:{ manage: true },
        billing:      { view: true, manage: true },
      },
      createdAt: now,
      updatedAt: now,
    });

    batch.set(auditRef, {
      id: auditId,
      type: "ORG_CREATED",
      orgId,
      ownerUid,
      ownerEmail,
      ownerName: ownerName || null,
      orgType,
      industry,
      timezone,
      callerUid,
      authUserCreated: authResult.created,
      mode: isEmu ? "emulator" : "production",
      occurredAt: now,
    });

    await batch.commit();

    // PEAKOPS_STARTER_TEMPLATES_V1 (Chunk 3B-2, 2026-06-22)
    // Best-effort starter template seed. Runs AFTER the atomic org+
    // owner-member batch commits so that a template-seed failure
    // never tears down the org/owner records. Idempotent: existing
    // template content is never overwritten (see seedStarterTemplate).
    let starterTemplate = null;
    try {
      starterTemplate = await seedStarterTemplate(db, orgId, industry);
    } catch (e) {
      console.warn("[createOrgV1] starter_template_seed_failed", {
        orgId, industry, msg: String(e && e.message || e),
      });
      starterTemplate = { seeded: false, reason: "seed_threw_exception" };
    }

    return j(res, 200, {
      ok: true,
      orgId,
      ownerUid,
      ownerEmail,
      ownerName: ownerName || null,
      industry,
      authUserCreated: authResult.created,
      starterTemplate,
      firstLoginUrl: firstLoginUrl || null,
      createdAt: new Date().toISOString(),
      already: false,
    });
  } catch (e) {
    console.error("[createOrgV1] failed", { msg: String(e && e.message || e) });
    return j(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});
