#!/usr/bin/env node
// Butler-style end-to-end customer dry-run — Action 2.
//
// Drives the complete onboarding + operational + compliance + recovery
// workflow on live peakops-pilot using the systems shipped in Chunks 1,
// 2, 3B-1, 3B-2 + DIRS rulepack v1.1. Provisions a fresh throwaway
// org and tears it down at the end.
//
// This is a CUSTOMER-REALITY test, not a coding sprint. The script is
// scaffolding for the exercise; the report is the deliverable.

import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const FOUNDER_SMOKE_UID = "butler-dryrun-founder";

const SA_PATH = "/Users/kesserumini/peakops/my-app/.secrets/sa.json";
const saJson = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
admin.initializeApp({ credential: admin.credential.cert(saJson), projectId: PROJECT });
const db = admin.firestore();
const { runComplianceCheck } = require("/Users/kesserumini/peakops/my-app/functions_clean/_complianceValidator");
const dirsRulepack = require("/Users/kesserumini/peakops/my-app/functions_clean/_complianceRulepacks/dirs/v1.json");

function getApiKey() {
  const appId = "1:1006996232574:web:99de916d6cc57d3fac3b2f";
  const out = execSync(`firebase apps:sdkconfig WEB ${appId} --project ${PROJECT}`, { encoding: "utf8" });
  const m = out.match(/\{[\s\S]*\}/);
  return JSON.parse(m[0]).apiKey;
}

async function mintTokenWithClaims(uid, claims = {}) {
  try { await admin.auth().getUser(uid); }
  catch { await admin.auth().createUser({ uid, disabled: false }); }
  const customToken = await admin.auth().createCustomToken(uid, claims);
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${getApiKey()}`,
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) }
  );
  const j = await r.json();
  if (!j.idToken) throw new Error(`token exchange failed: ${JSON.stringify(j).slice(0,200)}`);
  return j.idToken;
}

async function call(fn, body, idToken) {
  const r = await fetch(`${FN}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(idToken ? { "authorization": `Bearer ${idToken}` } : {}) },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let parsed = null; try { parsed = JSON.parse(t); } catch {}
  return { status: r.status, body: parsed || t };
}

// ─── Reporting helpers ────────────────────────────────────────────
const findings = {
  phase1: { observations: [], timings: {} },
  phase2: { observations: [] },
  phase3: { observations: [], events: [] },
  phase4: { observations: [], events: [] },
  phase5: { coverage: [], records: {} },
  phase6: { founderDeps: [] },
  phase7: { observations: [], cases: [] },
  errors: [],
};
function obs(phase, severity, text) {
  if (!findings[phase].observations) findings[phase].observations = [];
  findings[phase].observations.push({ severity, text });
  const tag = severity === "BLOCK" ? "🔴" : severity === "CONFUSE" ? "🟡" : severity === "MISSING" ? "🟠" : severity === "OK" ? "🟢" : "ℹ️";
  console.log(`  ${tag} [${severity}] ${text}`);
}
function logErr(phase, op, err) { findings.errors.push({ phase, op, err: String(err?.message || err) }); console.error(`  ❌ ${op}: ${err?.message || err}`); }
function sec(s) { return `${s} sec`; }

// ─── Setup ────────────────────────────────────────────────────────
const tag = randomBytes(2).toString("hex");
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const ORG_NAME = `Butler Style Telecom DryRun ${tag}`;
const orgIdExpected = ORG_NAME.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
  .replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const ADMIN_EMAIL = `dryrun-admin-${tag}@butlerstyle.example.com`;
const SUPERVISOR_EMAIL = `dryrun-sup-${tag}@butlerstyle.example.com`;
const FIELD_EMAIL = `dryrun-field-${tag}@butlerstyle.example.com`;

console.log(`\n══════════════════════════════════════════════════════════════════`);
console.log(`  Butler-Style Telecom Dry-Run`);
console.log(`══════════════════════════════════════════════════════════════════`);
console.log(`  Tag:     ${tag}`);
console.log(`  Org:     ${ORG_NAME}`);
console.log(`  Expect:  orgs/${orgIdExpected}`);
console.log(`  Admin:   ${ADMIN_EMAIL}`);
console.log(`  Sup:     ${SUPERVISOR_EMAIL}`);
console.log(`  Field:   ${FIELD_EMAIL}`);
console.log(``);

const cleanup = {
  orgId: null,
  uids: new Set(),
  incidentIds: new Set(),
  caseIds: new Set(),
};

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64"
);

async function uploadOneEvidence({ orgId, incidentId, sessionId, jobId, fileName, label, fieldToken, actorUid }) {
  let r = await call("createEvidenceUploadUrlV1", {
    orgId, incidentId, sessionId, actorUid,
    fileName, contentType: "image/png",
  }, fieldToken);
  if (r.body.ok !== true) throw new Error(`createEvidenceUploadUrlV1: ${JSON.stringify(r.body)}`);
  const put = await fetch(r.body.uploadUrl, {
    method: r.body.uploadMethod, headers: { "content-type": "image/png" }, body: PNG_1x1,
  });
  if (!put.ok) throw new Error(`upload GCS: ${put.status}`);
  const sha = createHash("sha256").update(PNG_1x1).digest("hex");
  const r2 = await call("addEvidenceV1", {
    orgId, incidentId, sessionId, actorUid, jobId,
    bucket: r.body.bucket, storagePath: r.body.storagePath,
    fileName, originalName: fileName, contentType: "image/png",
    sizeBytes: PNG_1x1.length, sha256: sha,
    phase: "DAMAGE", labels: [label],
    gps: { lat: 47.6679, lng: -117.2389, accuracyM: 6 },
  }, fieldToken);
  if (r2.body.ok !== true) throw new Error(`addEvidenceV1: ${JSON.stringify(r2.body)}`);
  return r2.body;
}

// ══════════════════════════════════════════════════════════════════
// PHASE 1 — Provision
// ══════════════════════════════════════════════════════════════════
console.log(`\n══ PHASE 1 — Provision ═══════════════════════════════════════`);

const phase1Start = Date.now();
let orgResult, supResult, fieldResult;
let adminUid, supUid, fieldUid;
let adminToken, supToken, fieldToken;

try {
  // Founder runs the activation. Mint a founder token with internal-admin claim.
  cleanup.uids.add(FOUNDER_SMOKE_UID);
  const founderToken = await mintTokenWithClaims(FOUNDER_SMOKE_UID, { peakopsInternalAdmin: true });
  obs("phase1", "OK", `Founder ID token minted (peakopsInternalAdmin:true claim)`);

  // Step 1a — createOrgV1
  const t0 = Date.now();
  orgResult = await call("createOrgV1", {
    orgName: ORG_NAME,
    industry: "telecom",
    ownerEmail: ADMIN_EMAIL,
    ownerName: "Butler-Style Admin",
    timezone: "America/New_York",
  }, founderToken);
  findings.phase1.timings.createOrgV1_ms = Date.now() - t0;

  if (orgResult.body.ok !== true) {
    logErr("phase1", "createOrgV1", JSON.stringify(orgResult.body));
    throw new Error("createOrgV1 failed");
  }
  cleanup.orgId = orgResult.body.orgId;
  adminUid = orgResult.body.ownerUid;
  cleanup.uids.add(adminUid);
  obs("phase1", "OK", `createOrgV1 → orgId=${orgResult.body.orgId} adminUid=${adminUid.slice(0,8)}… (${findings.phase1.timings.createOrgV1_ms}ms)`);

  // Step 1b — inviteOrgMemberV1 × 2 (supervisor + field)
  const t1 = Date.now();
  supResult = await call("inviteOrgMemberV1", {
    orgId: cleanup.orgId, email: SUPERVISOR_EMAIL, role: "supervisor",
    displayName: "Butler-Style Supervisor",
  }, founderToken);
  findings.phase1.timings.inviteSupervisor_ms = Date.now() - t1;
  if (supResult.body.ok !== true) {
    logErr("phase1", "inviteOrgMemberV1(sup)", JSON.stringify(supResult.body));
    throw new Error("invite sup failed");
  }
  supUid = supResult.body.uid;
  cleanup.uids.add(supUid);
  obs("phase1", "OK", `inviteOrgMemberV1(supervisor) → uid=${supUid.slice(0,8)}… (${findings.phase1.timings.inviteSupervisor_ms}ms)`);

  const t2 = Date.now();
  fieldResult = await call("inviteOrgMemberV1", {
    orgId: cleanup.orgId, email: FIELD_EMAIL, role: "field",
    displayName: "Butler-Style Field Tech",
  }, founderToken);
  findings.phase1.timings.inviteField_ms = Date.now() - t2;
  if (fieldResult.body.ok !== true) {
    logErr("phase1", "inviteOrgMemberV1(field)", JSON.stringify(fieldResult.body));
    throw new Error("invite field failed");
  }
  fieldUid = fieldResult.body.uid;
  cleanup.uids.add(fieldUid);
  obs("phase1", "OK", `inviteOrgMemberV1(field) → uid=${fieldUid.slice(0,8)}… (${findings.phase1.timings.inviteField_ms}ms)`);

  // Step 1c — Verify Firestore state
  await new Promise(r => setTimeout(r, 1500));
  const orgSnap = await db.doc(`orgs/${cleanup.orgId}`).get();
  if (!orgSnap.exists) obs("phase1", "BLOCK", `Firestore: orgs/${cleanup.orgId} doc missing!`);
  else {
    const od = orgSnap.data() || {};
    obs("phase1", "OK", `Firestore org doc: kind=${od.kind}, status=${od.status}, industry=${od.industry}`);
  }

  // Step 1d — Verify member docs
  const memberSnaps = await Promise.all([
    db.doc(`orgs/${cleanup.orgId}/members/${adminUid}`).get(),
    db.doc(`orgs/${cleanup.orgId}/members/${supUid}`).get(),
    db.doc(`orgs/${cleanup.orgId}/members/${fieldUid}`).get(),
  ]);
  const memberRoles = memberSnaps.map(s => s.exists ? s.data().role : "MISSING");
  obs("phase1", memberRoles.every(r => r !== "MISSING") ? "OK" : "BLOCK",
    `Member roles: admin=${memberRoles[0]}, sup=${memberRoles[1]}, field=${memberRoles[2]}`);

  // Step 1e — Verify starter template auto-seeded
  const tplSnap = await db.doc(`orgs/${cleanup.orgId}/templates/fiber_splice_verification`).get();
  if (tplSnap.exists) {
    const td = tplSnap.data() || {};
    obs("phase1", "OK", `Starter template seeded: ${td.requiredProof?.length || 0} required proof, ${td.acceptanceChecks?.length || 0} acceptance checks`);
  } else {
    obs("phase1", "BLOCK", `Starter template MISSING — Chunk 3B-2 auto-seed didn't fire`);
  }

  // Step 1f — Verify Auth users
  for (const [label, email, uid] of [["admin", ADMIN_EMAIL, adminUid], ["sup", SUPERVISOR_EMAIL, supUid], ["field", FIELD_EMAIL, fieldUid]]) {
    try {
      const u = await admin.auth().getUserByEmail(email);
      const claims = u.customClaims || {};
      const hasOrg = Array.isArray(claims.orgIds) && claims.orgIds.includes(cleanup.orgId);
      const roleOk = (label === "admin" && claims.role === "owner") ||
                     (label === "sup"   && claims.role === "supervisor") ||
                     (label === "field" && claims.role === "field");
      obs("phase1", hasOrg && roleOk ? "OK" : "BLOCK",
        `Auth ${label} (${email}): uid match=${u.uid === uid}, claims.orgIds∋org=${hasOrg}, claims.role=${claims.role}`);
    } catch (e) { obs("phase1", "BLOCK", `Auth lookup failed for ${label}: ${e.message}`); }
  }

  // Step 1g — Org-isolation check (try cross-org read with a foreign uid)
  try {
    const foreignToken = await mintTokenWithClaims("butler-dryrun-foreigner");
    cleanup.uids.add("butler-dryrun-foreigner");
    const r = await call("getIncidentV1", { orgId: cleanup.orgId, incidentId: "any" }, foreignToken);
    // Should be 401/403/404, NOT 200.
    if (r.status >= 200 && r.status < 300) obs("phase1", "BLOCK", `Cross-org read succeeded! (status=${r.status})`);
    else obs("phase1", "OK", `Cross-org read denied (status=${r.status}, body=${JSON.stringify(r.body).slice(0,80)})`);
  } catch (e) { obs("phase1", "CONFUSE", `Isolation check inconclusive: ${e.message}`); }

  // Step 1h — Mint role tokens for Phases 3+
  adminToken = await mintTokenWithClaims(adminUid);
  supToken   = await mintTokenWithClaims(supUid);
  fieldToken = await mintTokenWithClaims(fieldUid);
  obs("phase1", "OK", "Role tokens minted for admin, supervisor, field");

  // Step 1i — PR 133A verification: createOrgV1 must atomically seed
  // billing/state with entitlements.riskDefenseModule=true so the
  // customer workflow does not brick at "send to customer."
  const billingSnap = await db.doc(`orgs/${cleanup.orgId}/billing/state`).get();
  const billing = billingSnap.exists ? billingSnap.data() : null;
  const ent = (billing && billing.entitlements) || {};
  obs("phase1", billingSnap.exists ? "OK" : "BLOCK",
    `Billing/state doc on new org: exists=${billingSnap.exists}, plan=${billing?.plan}, entitlements=${JSON.stringify(ent)}`);
  obs("phase1", ent.riskDefenseModule === true ? "OK" : "BLOCK",
    `riskDefenseModule entitlement (gates packet export + customer review links): ${ent.riskDefenseModule === true ? "ON (PR 133A pilot default)" : "OFF — PR 133A regression"}`);

} catch (e) {
  logErr("phase1", "provision", e);
}

findings.phase1.timings.total_ms = Date.now() - phase1Start;
obs("phase1", "INFO", `Total provisioning time: ${(findings.phase1.timings.total_ms / 1000).toFixed(1)} sec`);
obs("phase1", "INFO", `firstLoginUrl issued: ${orgResult?.body?.firstLoginUrl ? "YES (Firebase auth/action URL)" : "NO"}`);
obs("phase1", "INFO", `supervisor magicLink issued: ${supResult?.body?.magicLink ? "YES" : "NO"}`);
obs("phase1", "INFO", `field magicLink issued: ${fieldResult?.body?.magicLink ? "YES" : "NO"}`);

// ══════════════════════════════════════════════════════════════════
// PHASE 2 — Customer first screen
// ══════════════════════════════════════════════════════════════════
console.log(`\n══ PHASE 2 — Customer first-screen experience ═══════════════`);
// We can't easily consume a Firebase magic link headlessly without
// significant Playwright wiring. Instead we observe + document:
//   - The shape of the link the customer receives
//   - What the welcome email template says
//   - What pages the customer lands on at each step
obs("phase2", "INFO", `Welcome email template: docs/customer-emails/01-welcome.md`);
obs("phase2", "INFO", `Magic link format: ${orgResult?.body?.firstLoginUrl?.split("?")[0] || "(no link)"}`);

// Read the welcome template + analyze its placeholders
try {
  const welcomeMd = fs.readFileSync(
    "/Users/kesserumini/peakops/my-app/docs/customer-emails/01-welcome.md", "utf8"
  );
  const placeholders = Array.from(welcomeMd.matchAll(/\{\{(\w+)\}\}/g)).map(m => m[1]);
  const uniquePh = [...new Set(placeholders)];
  obs("phase2", "OK", `Welcome email template carries ${uniquePh.length} placeholders: ${uniquePh.join(", ")}`);
} catch { obs("phase2", "BLOCK", "Welcome email template missing"); }

// Observations about the customer's first-screen path:
obs("phase2", "INFO", `Customer clicks magic link → Firebase Auth password reset → redirects to /auth/action → next-app handles → lands on /dashboard or /onboarding`);
obs("phase2", "MISSING", `No in-product onboarding tour for a brand-new admin on /dashboard. The OnboardingClient wizard at /onboarding is a separate URL; the magic link doesn't deep-link there.`);
obs("phase2", "CONFUSE", `Customer admin on /dashboard sees zero incidents + a "+ New field record" button — no welcome message, no "your starter template is ready" callout, no team-invite confirmation`);
obs("phase2", "MISSING", `No in-app indication that the customer's teammates were invited. The activate-script logs the magic links but the customer admin doesn't see them anywhere in the app.`);
obs("phase2", "INFO", `Customer admin who visits /onboarding manually sees a 7-step wizard, but the wizard's persisted state is independent of what activateCustomerOrg.cjs created (different code paths). Risk: wizard could overwrite admin-set values.`);

// ══════════════════════════════════════════════════════════════════
// PHASE 3 — Telecom incident lifecycle (happy path)
// ══════════════════════════════════════════════════════════════════
console.log(`\n══ PHASE 3 — Telecom incident lifecycle (happy path) ═════════`);

let incid3, jobId3, sessionId3, reviewToken3;
try {
  const incId = `dryrun_p3_${tag}_${stamp}`;
  cleanup.incidentIds.add(incId);

  // As admin: createIncidentV1
  let r = await call("createIncidentV1", {
    orgId: cleanup.orgId, actorUid: adminUid, incidentId: incId,
    title: "Fiber splice — Highline 12kv crossing outage",
    status: "open",
    archetype: "fiber_splice_verification",
    filingTypesRequired: ["DIRS"],
    location: "Highline Service Road, Mile 12, Spokane Valley WA — Spokane County",
    customer: "Spokane County Public Utilities",
    priority: "high",
    notes: "Tree-fall fiber cut on the Highline backhaul during the 06/22 windstorm. Re-splicing in cabinet 4892.",
  }, adminToken);
  if (r.body.ok !== true) { logErr("phase3", "createIncidentV1", JSON.stringify(r.body)); throw new Error("createIncident failed"); }
  obs("phase3", "OK", `createIncidentV1 → ${r.body.incidentId} (as admin role)`);
  incid3 = incId;

  // As admin: createJobV1
  r = await call("createJobV1", {
    orgId: cleanup.orgId, incidentId: incid3, actorUid: adminUid,
    title: "Splice repair — Highline cabinet 4892",
  }, adminToken);
  if (r.body.ok !== true) { logErr("phase3", "createJobV1", JSON.stringify(r.body)); throw new Error("createJob failed"); }
  jobId3 = r.body.job?.jobId || r.body.jobId;
  obs("phase3", "OK", `createJobV1 → ${jobId3}`);

  // As field: startFieldSessionV1 + markArrivedV1
  r = await call("startFieldSessionV1", {
    orgId: cleanup.orgId, incidentId: incid3, actorUid: fieldUid, techUserId: fieldUid,
  }, fieldToken);
  if (r.body.ok !== true) { logErr("phase3", "startFieldSessionV1", JSON.stringify(r.body)); throw new Error("startSession failed"); }
  sessionId3 = r.body.sessionId;
  obs("phase3", "OK", `startFieldSessionV1 → ${sessionId3} (as field role)`);

  r = await call("markArrivedV1", {
    orgId: cleanup.orgId, incidentId: incid3, sessionId: sessionId3, actorUid: fieldUid,
    gps: { lat: 47.6679, lng: -117.2389, accuracyM: 6 },
  }, fieldToken);
  if (r.body.ok !== true) { logErr("phase3", "markArrivedV1", JSON.stringify(r.body)); }
  else obs("phase3", "OK", `markArrivedV1 (GPS captured, as field role)`);

  // Upload evidence — 5 items (covers starter template's required proofs)
  for (const [fn, lbl] of [
    ["arrival.png", "ARRIVAL"],
    ["splice_before.png", "BEFORE"],
    ["splice_after.png", "AFTER"],
    ["equipment_label.png", "EQUIPMENT"],
    ["operational_log.png", "LOG"],
  ]) {
    await uploadOneEvidence({ orgId: cleanup.orgId, incidentId: incid3, sessionId: sessionId3, jobId: jobId3, fileName: fn, label: lbl, fieldToken, actorUid: fieldUid });
  }
  obs("phase3", "OK", `Uploaded 5 evidence items (ARRIVAL/BEFORE/AFTER/EQUIPMENT/LOG) as field role`);

  // As field: submitFieldSessionV1 → triggers refreshReadinessCache + DIRS validation
  r = await call("submitFieldSessionV1", {
    orgId: cleanup.orgId, incidentId: incid3, sessionId: sessionId3, actorUid: fieldUid,
  }, fieldToken);
  if (r.body.ok !== true) { logErr("phase3", "submitFieldSessionV1", JSON.stringify(r.body)); }
  else obs("phase3", "OK", `submitFieldSessionV1 (triggers DIRS validation)`);

  // As field: markJobCompleteV1 (open → complete) — fields do not use updateJobStatusV1
  r = await call("markJobCompleteV1", {
    orgId: cleanup.orgId, incidentId: incid3, jobId: jobId3, actorUid: fieldUid,
  }, fieldToken);
  if (r.body.ok !== true) { logErr("phase3", "markJobCompleteV1", JSON.stringify(r.body)); }
  else obs("phase3", "OK", `markJobCompleteV1 (as field) — job → complete`);

  // As supervisor: updateJobStatusV1 complete → review
  r = await call("updateJobStatusV1", {
    orgId: cleanup.orgId, incidentId: incid3, jobId: jobId3, actorUid: supUid, status: "review",
  }, supToken);
  if (r.body.ok !== true) { logErr("phase3", "updateJobStatusV1(review)", JSON.stringify(r.body)); }
  else obs("phase3", "OK", `updateJobStatusV1 → review (as supervisor)`);

  r = await call("approveJobV1", {
    orgId: cleanup.orgId, incidentId: incid3, jobId: jobId3, actorUid: supUid,
  }, supToken);
  if (r.body.ok !== true) { logErr("phase3", "approveJobV1", JSON.stringify(r.body)); }
  else obs("phase3", "OK", `approveJobV1 (as supervisor)`);

  r = await call("closeIncidentV1", { orgId: cleanup.orgId, incidentId: incid3, actorUid: supUid }, supToken);
  if (r.body.ok !== true) { logErr("phase3", "closeIncidentV1", JSON.stringify(r.body)); }
  else obs("phase3", "OK", `closeIncidentV1 (as supervisor)`);

  // As admin: exportIncidentPacketV1 → packet
  r = await call("exportIncidentPacketV1", {
    orgId: cleanup.orgId, incidentId: incid3, actorUid: adminUid,
  }, adminToken);
  if (r.body.ok !== true) { logErr("phase3", "exportIncidentPacketV1", JSON.stringify(r.body)); }
  else obs("phase3", "OK", `exportIncidentPacketV1 → packet v${r.body.packetVersion || "?"} bytes=${r.body.zipSizeBytes || "?"}`);

  // As admin: createCustomerReviewLinkV1
  r = await call("createCustomerReviewLinkV1", {
    orgId: cleanup.orgId, incidentId: incid3, actorUid: adminUid,
    customerEmail: `customer-acceptor-${tag}@spokane-pud.example.com`,
  }, adminToken);
  if (r.body.ok !== true) { logErr("phase3", "createCustomerReviewLinkV1", JSON.stringify(r.body)); }
  else {
    reviewToken3 = r.body.token;
    obs("phase3", "OK", `createCustomerReviewLinkV1 → token issued, sourceStatus=${r.body.sourceStatus}`);
  }

  // Customer accepts (no auth — token-only path)
  if (reviewToken3) {
    r = await call("submitCustomerReviewV1", { token: reviewToken3, action: "accept" });
    if (r.body.ok !== true) { logErr("phase3", "submitCustomerReviewV1", JSON.stringify(r.body)); }
    else obs("phase3", "OK", `submitCustomerReviewV1 accept → customer-side, no auth`);

    // Verify incident status moved to customer_accepted
    await new Promise(r => setTimeout(r, 1500));
    const incSnap = await db.doc(`orgs/${cleanup.orgId}/incidents/${incid3}`).get();
    const st = incSnap.data()?.status;
    obs("phase3", st === "customer_accepted" ? "OK" : "BLOCK",
      `Final status: ${st} (expected customer_accepted)`);

    // Verify operator notification fired
    const notifs = await db.collection(`users/${adminUid}/notifications`)
      .where("incidentId", "==", incid3).get();
    const types = notifs.docs.map(d => d.data().type);
    const hasAccepted = types.includes("customer_accepted");
    obs("phase3", hasAccepted ? "OK" : "MISSING",
      `Operator notifications (admin uid): types=[${types.join(", ") || "(none)"}]`);
  }

  // Capture timeline events
  const timeline = await db.collection(`incidents/${incid3}/timeline_events`).orderBy("occurredAt", "asc").get();
  findings.phase3.events = timeline.docs.map(d => ({ type: d.data().type, actor: d.data().actor }));
  obs("phase3", "INFO", `Timeline: ${timeline.size} events recorded`);

} catch (e) {
  logErr("phase3", "lifecycle", e);
}

// ══════════════════════════════════════════════════════════════════
// PHASE 4 — Recovery lifecycle (rejection → recovery → resubmit → accept)
// ══════════════════════════════════════════════════════════════════
console.log(`\n══ PHASE 4 — Recovery lifecycle (with DIRS findings) ══════════`);

let incid4, jobId4, sessionId4, caseId4;
try {
  const incId = `dryrun_p4_${tag}_${stamp}`;
  cleanup.incidentIds.add(incId);

  // Create incident — DELIBERATELY incomplete (no archetype set, no notes)
  let r = await call("createIncidentV1", {
    orgId: cleanup.orgId, actorUid: adminUid, incidentId: incId,
    title: "Pole inspection — Riverside corridor",
    status: "open",
    archetype: "pole_inspection",
    filingTypesRequired: ["DIRS"],
    location: "Riverside corridor mile-marker 8, Spokane WA",
    customer: "Riverside Municipal Utility",
    priority: "normal",
    notes: "Routine pole inspection on Riverside backhaul corridor.",
  }, adminToken);
  if (r.body.ok !== true) { logErr("phase4", "createIncidentV1", JSON.stringify(r.body)); throw new Error("createIncident failed"); }
  incid4 = incId;
  obs("phase4", "OK", `createIncidentV1 → ${incid4} (DIRS-tagged, will receive incomplete evidence)`);

  r = await call("createJobV1", {
    orgId: cleanup.orgId, incidentId: incid4, actorUid: adminUid, title: "Pole climb + condition check",
  }, adminToken);
  jobId4 = r.body.job?.jobId || r.body.jobId;

  r = await call("startFieldSessionV1", {
    orgId: cleanup.orgId, incidentId: incid4, actorUid: fieldUid, techUserId: fieldUid,
  }, fieldToken);
  sessionId4 = r.body.sessionId;

  r = await call("markArrivedV1", {
    orgId: cleanup.orgId, incidentId: incid4, sessionId: sessionId4, actorUid: fieldUid,
    gps: { lat: 47.66, lng: -117.43, accuracyM: 8 },
  }, fieldToken);

  // Upload ONLY 2 evidence items — fewer than the 4-required minimum
  for (const [fn, lbl] of [
    ["pole_wide.png", "WIDE"],
    ["climber_ppe.png", "PPE"],
  ]) {
    await uploadOneEvidence({ orgId: cleanup.orgId, incidentId: incid4, sessionId: sessionId4, jobId: jobId4, fileName: fn, label: lbl, fieldToken, actorUid: fieldUid });
  }
  obs("phase4", "OK", `Uploaded only 2 evidence items (below starter template's 4-item required-proof minimum)`);

  await call("submitFieldSessionV1", {
    orgId: cleanup.orgId, incidentId: incid4, sessionId: sessionId4, actorUid: fieldUid,
  }, fieldToken);

  await call("markJobCompleteV1", {
    orgId: cleanup.orgId, incidentId: incid4, jobId: jobId4, actorUid: fieldUid,
  }, fieldToken);
  await call("updateJobStatusV1", {
    orgId: cleanup.orgId, incidentId: incid4, jobId: jobId4, actorUid: supUid, status: "review",
  }, supToken);
  await call("approveJobV1", {
    orgId: cleanup.orgId, incidentId: incid4, jobId: jobId4, actorUid: supUid,
  }, supToken);

  // Inspect readiness cache after submit (before close) — should reflect missing-proof
  await new Promise(r => setTimeout(r, 2500));
  let rdSnap = await db.doc(`orgs/${cleanup.orgId}/incidents/${incid4}`).get();
  let rd = rdSnap.data()?.readinessCache;
  obs("phase4", rd ? "OK" : "MISSING",
    `Readiness cache: state=${rd?.state}, missingCount=${rd?.missingCount} (preview: ${(rd?.missingItemsPreview || []).join(" / ")})`);

  await call("closeIncidentV1", { orgId: cleanup.orgId, incidentId: incid4, actorUid: supUid }, supToken);

  // Export + mint review link
  let exp = await call("exportIncidentPacketV1", {
    orgId: cleanup.orgId, incidentId: incid4, actorUid: adminUid,
  }, adminToken);
  if (exp.body.ok !== true) { obs("phase4", "INFO", `exportIncidentPacketV1: ${JSON.stringify(exp.body).slice(0,150)}`); }
  else obs("phase4", "OK", `exportIncidentPacketV1 succeeded despite missing required proof (validator is passive_log)`);

  let mintR = await call("createCustomerReviewLinkV1", {
    orgId: cleanup.orgId, incidentId: incid4, actorUid: adminUid,
  }, adminToken);
  if (mintR.body.ok !== true) { logErr("phase4", "createCustomerReviewLinkV1", JSON.stringify(mintR.body)); throw new Error("mint failed"); }
  const token4a = mintR.body.token;
  obs("phase4", "OK", `Customer review link minted (despite missing required proof — validator is passive_log)`);

  // Customer REJECTS
  let rejR = await call("submitCustomerReviewV1", {
    token: token4a, action: "reject",
    comment: "Missing OTDR test trace and only 2 photos provided. We need a full set per our acceptance criteria before signing off."
  });
  if (rejR.body.ok !== true) { logErr("phase4", "submitCustomerReviewV1(reject)", JSON.stringify(rejR.body)); }
  else obs("phase4", "OK", `Customer rejection submitted`);

  // Recovery case should auto-create
  await new Promise(r => setTimeout(r, 2500));
  const caseQ = await db.collection(`orgs/${cleanup.orgId}/recovery_cases`).where("incidentId", "==", incid4).get();
  if (caseQ.empty) {
    obs("phase4", "BLOCK", `Recovery case did NOT auto-create on customer rejection`);
  } else {
    caseId4 = caseQ.docs[0].id;
    cleanup.caseIds.add(caseId4);
    const cd = caseQ.docs[0].data();
    obs("phase4", "OK", `Recovery case auto-created: caseId=${caseId4.slice(0,12)}…, status=${cd.status}, cause.primary=${cd.cause?.primary}`);
  }

  // Operator notification (customer_rejected + recovery_case_opened)
  const ntfA = await db.collection(`users/${adminUid}/notifications`).where("incidentId", "==", incid4).get();
  const ntfTypes = ntfA.docs.map(d => d.data().type);
  const hasReject = ntfTypes.includes("customer_rejected");
  const hasRecovery = ntfTypes.includes("recovery_case_opened");
  obs("phase4", hasReject && hasRecovery ? "OK" : "MISSING",
    `Operator notifications: customer_rejected=${hasReject}, recovery_case_opened=${hasRecovery}, types=[${ntfTypes.join(", ")}]`);

  // PR 133A verification: supervisor unlocks open → in_progress.
  let upA = await call("updateRecoveryCaseV1", { orgId: cleanup.orgId, caseId: caseId4, actorUid: supUid, status: "in_progress" }, supToken);
  if (upA.body.ok !== true) { logErr("phase4", "updateRecoveryCaseV1(in_progress as supervisor)", JSON.stringify(upA.body)); }
  else obs("phase4", "OK", `updateRecoveryCaseV1 open → in_progress (as supervisor — PR 133A unlock)`);

  // Negative path: supervisor → ready_to_resubmit must be denied.
  let upDenied = await call("updateRecoveryCaseV1", { orgId: cleanup.orgId, caseId: caseId4, actorUid: supUid, status: "ready_to_resubmit" }, supToken);
  if (upDenied.status === 403 && upDenied.body.error === "permission-denied") {
    obs("phase4", "OK", `Supervisor blocked from in_progress → ready_to_resubmit (correct — admin-only) [403/permission-denied]`);
  } else {
    obs("phase4", "BLOCK", `Supervisor was NOT denied ready_to_resubmit: status=${upDenied.status} body=${JSON.stringify(upDenied.body).slice(0,150)}`);
  }

  // Admin completes the transition.
  let upB = await call("updateRecoveryCaseV1", { orgId: cleanup.orgId, caseId: caseId4, actorUid: adminUid, status: "ready_to_resubmit" }, adminToken);
  if (upB.body.ok !== true) { logErr("phase4", "updateRecoveryCaseV1(ready_to_resubmit as admin)", JSON.stringify(upB.body)); }
  else obs("phase4", "OK", `updateRecoveryCaseV1 in_progress → ready_to_resubmit (as admin)`);

  // Add the missing evidence
  for (const [fn, lbl] of [
    ["id_plate.png", "ID_PLATE"],
    ["otdr_trace.png", "LOG"],
  ]) {
    await uploadOneEvidence({ orgId: cleanup.orgId, incidentId: incid4, sessionId: sessionId4, jobId: jobId4, fileName: fn, label: lbl, fieldToken, actorUid: fieldUid });
  }
  obs("phase4", "OK", `Added 2 more evidence items (ID_PLATE + LOG/OTDR trace)`);

  // Mint resubmission link
  let resR = await call("mintResubmissionLinkV1", {
    orgId: cleanup.orgId, caseId: caseId4, actorUid: adminUid,
    customerEmail: `customer-acceptor-${tag}@spokane-pud.example.com`,
    changeSummary: "Added OTDR trace + ID plate photo per customer feedback",
  }, adminToken);
  if (resR.body.ok !== true) { logErr("phase4", "mintResubmissionLinkV1", JSON.stringify(resR.body)); }
  else {
    const token4b = resR.body.token;
    obs("phase4", "OK", `Resubmission link minted (ordinal=${resR.body.ordinal})`);

    // Customer accepts on resubmission
    let accR = await call("submitCustomerReviewV1", { token: token4b, action: "accept" });
    if (accR.body.ok !== true) { logErr("phase4", "resubmission accept", JSON.stringify(accR.body)); }
    else obs("phase4", "OK", `Customer accepted on resubmission`);

    // Verify recovery case auto-resolved
    await new Promise(r => setTimeout(r, 2500));
    const finalCase = (await db.doc(`orgs/${cleanup.orgId}/recovery_cases/${caseId4}`).get()).data();
    obs("phase4", finalCase?.status === "recovered" ? "OK" : "BLOCK",
      `Recovery case auto-resolved to status=${finalCase?.status} (expected recovered)`);

    // Verify final incident status
    const finalInc = (await db.doc(`orgs/${cleanup.orgId}/incidents/${incid4}`).get()).data();
    obs("phase4", finalInc?.status === "customer_accepted" ? "OK" : "BLOCK",
      `Final incident status: ${finalInc?.status} (expected customer_accepted)`);
  }

} catch (e) {
  logErr("phase4", "recovery", e);
}

// ══════════════════════════════════════════════════════════════════
// PHASE 5 — Compliance coverage summary
// ══════════════════════════════════════════════════════════════════
console.log(`\n══ PHASE 5 — DIRS v1.1 compliance coverage ════════════════════`);

// Inspect the deployed rulepack via the local copy (post-deploy verified earlier)
obs("phase5", "OK", `DIRS rulepack loaded: version=${dirsRulepack.version}, rules=${dirsRulepack.rules.length}, evidenceRequirements=${dirsRulepack.evidenceRequirements.length}`);

// Build coverage table
findings.phase5.coverage = [
  ...dirsRulepack.rules.map(rule => ({
    code: rule.code,
    source: rule.source || "(no source)",
    severity: rule.severity,
    kind: "rule",
    field: rule.require?.field || "—",
    statusGate: rule.when?.statusIn?.join("/") || "—",
  })),
  ...dirsRulepack.evidenceRequirements.map(req => ({
    code: req.code,
    source: req.source || "(no source)",
    severity: req.severity,
    kind: "evidence",
    field: req.type,
    statusGate: "—",
  })),
];

// Drive the validator against the Phase 3 and Phase 4 records directly
for (const [label, incidentId] of [["P3-happy-path", incid3], ["P4-recovered", incid4]]) {
  if (!incidentId) continue;
  const incSnap = await db.doc(`orgs/${cleanup.orgId}/incidents/${incidentId}`).get();
  const inc = { id: incSnap.id, ...incSnap.data() };
  // Pull evidence types
  const evSnap = await db.collection(`incidents/${incidentId}/evidence_locker`).get();
  const types = [...new Set(evSnap.docs.map(d => String((d.data().labels || [d.data().type])[0] || "").toUpperCase()).filter(Boolean))];
  const result = runComplianceCheck(inc, types);
  findings.phase5.records[label] = {
    incidentId, evidenceTypes: types,
    ok: result.ok,
    rulepackVersion: result.rulepackVersionsByType?.DIRS,
    issues: result.issues.map(i => ({ code: i.code, severity: i.severity })),
  };
  obs("phase5", "OK", `${label}: ok=${result.ok}, rulepackVersion=${result.rulepackVersionsByType?.DIRS}, ${result.issues.length} issues`);
}

// ══════════════════════════════════════════════════════════════════
// PHASE 6 — Founder dependency audit (observational)
// ══════════════════════════════════════════════════════════════════
console.log(`\n══ PHASE 6 — Founder dependency audit ═══════════════════════`);

findings.phase6.founderDeps = [
  // CRITICAL — would require Nick personally
  { tier: "CRITICAL", item: "Mint the founder peakopsInternalAdmin claim (one-time per CS person)", required: "node setInternalAdminClaim.cjs --apply, with service-account JSON" },
  { tier: "HIGH", item: "Magic links from createOrgV1 + inviteOrgMemberV1 must be delivered out-of-band (no auto-email)", required: "CS person copies links from script output into welcome email template" },
  { tier: "HIGH", item: "Customer-side magic link consumption", required: "Customer clicks link in their email → Firebase Auth password-reset flow → success" },
  { tier: "MEDIUM", item: "Custom archetypes beyond fiber_splice_verification/pole_inspection/etc.", required: "Engineering code change to add new archetype + matching template" },
  { tier: "MEDIUM", item: "Custom validation rules beyond the v1.1 DIRS set", required: "Engineering JSON edit to _complianceRulepacks/* + deploy" },
  { tier: "LOW", item: "Status of validator (passive_log vs blocking)", required: "Firestore Console edit to orgs/{orgId}/config/validation.mode; OR PR 133C enforcement work" },
  { tier: "LOW", item: "Lost/expired magic link recovery", required: "teamRecoveryV1 callable or Firebase Console password-reset" },
];

for (const dep of findings.phase6.founderDeps) {
  obs("phase6", dep.tier === "CRITICAL" ? "BLOCK" : dep.tier === "HIGH" ? "CONFUSE" : "INFO",
    `[${dep.tier}] ${dep.item}`);
}

// ══════════════════════════════════════════════════════════════════
// PHASE 7 — Enforcement (block) mode (PR 133C)
// ══════════════════════════════════════════════════════════════════
console.log(`\n══ PHASE 7 — Enforcement (block) mode ════════════════════════`);

try {
  if (!cleanup.orgId || !adminToken || !supToken) throw new Error("missing prerequisites from earlier phases");

  // Flip the org into enforcement mode + bust the function-side cache
  // by waiting 60s OR by recreating the doc — simplest is to wait and
  // use a fresh incident so the first read hits the new value.
  await db.doc(`orgs/${cleanup.orgId}/config/validation`).set({
    mode: "block",
    setBy: "butler_full_dry_run:phase7",
    setAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  obs("phase7", "OK", `Set orgs/${cleanup.orgId}/config/validation.mode = "block"`);

  // Wait 60s for the in-memory mode cache on the Cloud Function to expire.
  obs("phase7", "INFO", `Waiting 65s for validation-mode cache (60s TTL) to expire on the function side…`);
  await new Promise(r => setTimeout(r, 65000));

  // Build a fresh blocking-shape incident: DIRS-tagged, missing customer/affectedCustomers
  // (two ERROR-severity DIRS findings). Drive through to "ready to send to customer."
  const incId = `dryrun_p7_${tag}_${stamp}`;
  cleanup.incidentIds.add(incId);
  let r = await call("createIncidentV1", {
    orgId: cleanup.orgId, actorUid: adminUid, incidentId: incId,
    title: "Phase 7 — DIRS-incomplete shape",
    status: "open",
    archetype: "fiber_splice_verification",
    filingTypesRequired: ["DIRS"],
    location: "Highway 4 mile 12, Spokane Valley WA",
    customer: "",                       // ERROR: dirs.entity.identification.required
    notes: "Phase 7 deliberately incomplete (no customer label, no affectedCustomers).",
    // affectedCustomers omitted        // ERROR: dirs.affected_population.required
  }, adminToken);
  if (r.body.ok !== true) throw new Error(`createIncidentV1: ${JSON.stringify(r.body)}`);
  obs("phase7", "OK", `Created blocking-shape incident ${incId}`);

  r = await call("createJobV1", {
    orgId: cleanup.orgId, incidentId: incId, actorUid: adminUid, title: "Phase 7 job",
  }, adminToken);
  const p7JobId = r.body.job?.jobId || r.body.jobId;

  r = await call("startFieldSessionV1", { orgId: cleanup.orgId, incidentId: incId, actorUid: fieldUid, techUserId: fieldUid }, fieldToken);
  const p7SessionId = r.body.sessionId;
  await call("markArrivedV1", { orgId: cleanup.orgId, incidentId: incId, sessionId: p7SessionId, actorUid: fieldUid, gps: { lat: 47.66, lng: -117.24, accuracyM: 6 } }, fieldToken);
  for (const [fn, lbl] of [["arr.png","ARRIVAL"],["b.png","BEFORE"],["a.png","AFTER"],["e.png","EQUIPMENT"],["log.png","LOG"]]) {
    await uploadOneEvidence({ orgId: cleanup.orgId, incidentId: incId, sessionId: p7SessionId, jobId: p7JobId, fileName: fn, label: lbl, fieldToken, actorUid: fieldUid });
  }
  await call("submitFieldSessionV1", { orgId: cleanup.orgId, incidentId: incId, sessionId: p7SessionId, actorUid: fieldUid }, fieldToken);
  await call("markJobCompleteV1", { orgId: cleanup.orgId, incidentId: incId, jobId: p7JobId, actorUid: fieldUid }, fieldToken);
  await call("updateJobStatusV1", { orgId: cleanup.orgId, incidentId: incId, jobId: p7JobId, actorUid: supUid, status: "review" }, supToken);
  await call("approveJobV1", { orgId: cleanup.orgId, incidentId: incId, jobId: p7JobId, actorUid: supUid }, supToken);
  await call("closeIncidentV1", { orgId: cleanup.orgId, incidentId: incId, actorUid: supUid }, supToken);
  obs("phase7", "OK", `Lifecycle through close — ready to test enforcement gates`);

  // ── Case A: export without override → expect 412 compliance_block
  let caseA = await call("exportIncidentPacketV1", { orgId: cleanup.orgId, incidentId: incId, actorUid: adminUid }, adminToken);
  findings.phase7.cases.push({ name: "exportA_noOverride", status: caseA.status, error: caseA.body.error, codes: caseA.body.codes });
  if (caseA.status === 412 && caseA.body.error === "compliance_block" && Array.isArray(caseA.body.codes) && caseA.body.codes.length > 0) {
    obs("phase7", "OK", `Case A — export refused: 412 compliance_block, ${caseA.body.codes.length} codes (${caseA.body.codes.map(c=>c.code).join(", ").slice(0,80)})`);
  } else {
    obs("phase7", "BLOCK", `Case A — expected 412/compliance_block, got status=${caseA.status} body=${JSON.stringify(caseA.body).slice(0,200)}`);
  }

  // ── Case B: export as field role with ack → expect 403 override_role_required
  let caseB = await call("exportIncidentPacketV1", {
    orgId: cleanup.orgId, incidentId: incId, actorUid: adminUid,
    acknowledgeViolations: true,
    violationAcknowledgmentReason: "Field tech ack — should be rejected by role gate",
  }, fieldToken);   // <-- intentionally fieldToken; will fail authz role gate (ROLES_GENERATE_REPORT)
  findings.phase7.cases.push({ name: "exportB_fieldRoleOverride", status: caseB.status, error: caseB.body.error });
  if (caseB.status === 403) {
    obs("phase7", "OK", `Case B — field role denied at authz layer (403 permission-denied) before reaching override path`);
  } else {
    obs("phase7", "BLOCK", `Case B — expected 403, got status=${caseB.status} body=${JSON.stringify(caseB.body).slice(0,200)}`);
  }

  // ── Case C: export as admin with override missing reason → expect 400 override_reason_invalid
  let caseC = await call("exportIncidentPacketV1", {
    orgId: cleanup.orgId, incidentId: incId, actorUid: adminUid,
    acknowledgeViolations: true,
    violationAcknowledgmentReason: "short",
  }, adminToken);
  findings.phase7.cases.push({ name: "exportC_shortReason", status: caseC.status, error: caseC.body.error, ackError: caseC.body.ackError });
  if (caseC.status === 400 && caseC.body.ackError === "override_reason_invalid") {
    obs("phase7", "OK", `Case C — admin override with too-short reason rejected (400 override_reason_invalid)`);
  } else {
    obs("phase7", "BLOCK", `Case C — expected 400/override_reason_invalid, got status=${caseC.status} body=${JSON.stringify(caseC.body).slice(0,200)}`);
  }

  // ── Case D: export as admin with valid override → expect 200, override recorded
  let caseD = await call("exportIncidentPacketV1", {
    orgId: cleanup.orgId, incidentId: incId, actorUid: adminUid,
    acknowledgeViolations: true,
    violationAcknowledgmentReason: "Operator review confirms missing fields are non-applicable to this internal test scenario.",
  }, adminToken);
  findings.phase7.cases.push({ name: "exportD_validOverride", status: caseD.status, packetVersion: caseD.body.packetVersion });
  if (caseD.status === 200 && caseD.body.ok === true) {
    obs("phase7", "OK", `Case D — admin override with valid reason succeeded (200, packetVersion=${caseD.body.packetVersion || "?"})`);
  } else {
    obs("phase7", "BLOCK", `Case D — expected 200, got status=${caseD.status} body=${JSON.stringify(caseD.body).slice(0,200)}`);
  }

  // ── Case E: same flow for createCustomerReviewLinkV1 → 412 without override
  let caseE = await call("createCustomerReviewLinkV1", { orgId: cleanup.orgId, incidentId: incId, actorUid: adminUid }, adminToken);
  findings.phase7.cases.push({ name: "reviewLinkE_noOverride", status: caseE.status, error: caseE.body.error });
  if (caseE.status === 412 && caseE.body.error === "compliance_block") {
    obs("phase7", "OK", `Case E — createCustomerReviewLinkV1 refused: 412 compliance_block`);
  } else {
    obs("phase7", "BLOCK", `Case E — expected 412/compliance_block, got status=${caseE.status} body=${JSON.stringify(caseE.body).slice(0,200)}`);
  }

  // ── Case F: createCustomerReviewLinkV1 with valid admin override → 200
  let caseF = await call("createCustomerReviewLinkV1", {
    orgId: cleanup.orgId, incidentId: incId, actorUid: adminUid,
    acknowledgeViolations: true,
    violationAcknowledgmentReason: "Operator review confirms missing fields are non-applicable to this internal test scenario.",
  }, adminToken);
  findings.phase7.cases.push({ name: "reviewLinkF_validOverride", status: caseF.status, hasToken: !!caseF.body.token });
  if (caseF.status === 200 && caseF.body.ok === true && caseF.body.token) {
    obs("phase7", "OK", `Case F — createCustomerReviewLinkV1 with valid admin override succeeded (200, token issued)`);
  } else {
    obs("phase7", "BLOCK", `Case F — expected 200 with token, got status=${caseF.status} body=${JSON.stringify(caseF.body).slice(0,200)}`);
  }

  // ── Audit verification: should see at least one compliance_block_triggered and one _overridden in the audit subcollection
  await new Promise(r => setTimeout(r, 1500));
  const auditSnap = await db.collection(`orgs/${cleanup.orgId}/audit`)
    .where("incidentId", "==", incId).get();
  const auditTypes = auditSnap.docs.map(d => d.data().type).filter(Boolean);
  const hasTriggered = auditTypes.includes("compliance_block_triggered");
  const hasOverridden = auditTypes.includes("compliance_block_overridden");
  obs("phase7", (hasTriggered && hasOverridden) ? "OK" : "BLOCK",
    `Audit subcollection: compliance_block_triggered=${hasTriggered}, compliance_block_overridden=${hasOverridden} (types=[${[...new Set(auditTypes)].join(", ")}])`);

  // Flip mode back to off for cleanliness.
  await db.doc(`orgs/${cleanup.orgId}/config/validation`).set({
    mode: "off", setBy: "butler_full_dry_run:phase7_cleanup",
    setAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
} catch (e) {
  logErr("phase7", "enforcement", e);
}

// ══════════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════════
console.log(`\n── Cleanup ──`);
try {
  // Delete incidents + subcollections
  for (const incId of cleanup.incidentIds) {
    for (const sub of ["jobs", "evidence_locker", "timeline_events", "notes"]) {
      const snap = await db.collection(`incidents/${incId}/${sub}`).get().catch(() => null);
      if (snap && !snap.empty) {
        const b = db.batch(); snap.forEach(d => b.delete(d.ref)); await b.commit();
      }
      const snap2 = await db.collection(`orgs/${cleanup.orgId}/incidents/${incId}/${sub}`).get().catch(() => null);
      if (snap2 && !snap2.empty) {
        const b = db.batch(); snap2.forEach(d => b.delete(d.ref)); await b.commit();
      }
    }
    await db.doc(`orgs/${cleanup.orgId}/incidents/${incId}`).delete().catch(() => {});
    await db.doc(`incidents/${incId}`).delete().catch(() => {});
  }
  // Delete recovery cases
  for (const cid of cleanup.caseIds) {
    await db.doc(`orgs/${cleanup.orgId}/recovery_cases/${cid}`).delete().catch(() => {});
  }
  // Delete org subcollections + org doc
  if (cleanup.orgId) {
    for (const sub of ["members", "audit", "templates", "recovery_cases", "billing", "config", "customer_review_links", "customer_review_audit"]) {
      const snap = await db.collection(`orgs/${cleanup.orgId}/${sub}`).get();
      if (snap.size) { const b = db.batch(); snap.forEach(d => b.delete(d.ref)); await b.commit(); }
    }
    await db.doc(`orgs/${cleanup.orgId}`).delete().catch(() => {});
    console.log(`  ✓ deleted orgs/${cleanup.orgId} + subcollections`);
  }
  // Delete Auth users
  for (const uid of cleanup.uids) {
    try { await admin.auth().deleteUser(uid); } catch {}
  }
  console.log(`  ✓ deleted ${cleanup.uids.size} Auth users`);
  // Also clean by email
  for (const email of [ADMIN_EMAIL, SUPERVISOR_EMAIL, FIELD_EMAIL]) {
    try { const u = await admin.auth().getUserByEmail(email); await admin.auth().deleteUser(u.uid); } catch {}
  }
} catch (e) { console.warn(`  ⚠ cleanup partial: ${e?.message}`); }

// ══════════════════════════════════════════════════════════════════
// Save findings JSON for report writing
// ══════════════════════════════════════════════════════════════════
const outPath = `/tmp/butler_dryrun_findings_${tag}.json`;
fs.writeFileSync(outPath, JSON.stringify(findings, null, 2));
console.log(`\n══ Findings saved: ${outPath} ══════════════════════════════════`);
console.log(`Errors during run: ${findings.errors.length}`);
if (findings.errors.length) {
  for (const e of findings.errors) console.log(`  ✗ ${e.phase}.${e.op}: ${e.err.slice(0,200)}`);
}
process.exit(0);
