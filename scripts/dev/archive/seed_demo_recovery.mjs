#!/usr/bin/env node
// PEAKOPS_DEMO_SEED_V1 (PR 133)
//
// Seeds the peakops-demo org with a full Revenue Protection & Recovery
// demo flow. Walks two historical rejection→recovery cycles through
// real product endpoints (so audit chains + aggregates fire correctly),
// then leaves a fresh demo-live incident at "ready to send to customer"
// state for the presenter to walk live.
//
// Architecture lock decisions (PR 133 planning, locked 2026-06-09):
//   1. Org provisioning is manual one-time (see docs/DEMO_SETUP_ORG.md)
//   2. Incognito customer browser at presentation time
//   3. Dedicated demo accounts (demo-admin, demo-foreman, demo-coordinator)
//   4. On-demand refresh before demos
//   5. Docs in repo
//   6. Single PR
//
// Hard safety rail: this script ONLY runs against orgId=peakops-demo.
// Any other org → immediate exit. We never write to peakops-internal-alpha
// or any customer org from this script.
//
// Usage:
//   node scripts/dev/seed_demo_recovery.mjs --org peakops-demo --action seed
//   node scripts/dev/seed_demo_recovery.mjs --org peakops-demo --action reset
//   node scripts/dev/seed_demo_recovery.mjs --org peakops-demo --action refresh
//
// Actions:
//   seed    — abandon any open cases, ensure template + 2 historicals exist,
//             create today's demo-live incident in "ready to mint" state.
//             Idempotent: re-runs are safe.
//   reset   — abandon any non-terminal recovery cases. Leaves recovered
//             cases (and the template_gap aggregate) intact.
//   refresh — for historical incidents older than 20 days, create fresh
//             ones with today's audit timestamps so the 30-day window
//             stays populated. Old incidents fall out naturally.

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

// ── Args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def = null) {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || i === args.length - 1) return def;
  return args[i + 1];
}
function flag(name) { return args.includes(`--${name}`); }

const ORG_ID = arg("org");
const ACTION = arg("action", "seed");
const PROJECT = arg("project", "peakops-pilot");
const VERBOSE = flag("verbose");

// ── HARD SAFETY: only peakops-demo ────────────────────────────────
if (ORG_ID !== "peakops-demo") {
  console.error(`ERROR: --org must be exactly "peakops-demo". Got: ${ORG_ID}`);
  console.error("This script will NOT run against any other org. This is a hard safety rail.");
  process.exit(2);
}
if (!["seed", "reset", "refresh"].includes(ACTION)) {
  console.error(`ERROR: --action must be one of: seed, reset, refresh. Got: ${ACTION}`);
  process.exit(2);
}

// ── Firebase init ─────────────────────────────────────────────────
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const FN_BASE = `https://us-central1-${PROJECT}.cloudfunctions.net`;

// ── Demo constants (must match docs/DEMO_SETUP_ORG.md) ────────────
const ADMIN_UID = "demo-admin";
const COORDINATOR_UID = "demo-coordinator";
const FOREMAN_UID = "demo-foreman";

const TEMPLATE_KEY = "fiber_splice_verification__acme-telecom";
const TEMPLATE_VERSION = 7;
const CUSTOMER_LABEL = "Acme Telecom";
const ARCHETYPE = "fiber_splice_verification";

// Historical incidents — fixed IDs so re-runs are idempotent
const HIST_1 = {
  incidentId: "demo-historical-1",
  title: "Fiber splice — Site Birch Run · West vault",
  rejectComment: "We need the OTDR trace before signoff.",
  revenue: 3200,
};
const HIST_2 = {
  incidentId: "demo-historical-2",
  title: "Fiber splice — Site Birch Run · East vault",
  rejectComment: "Test results aren't attached.",
  revenue: 4800,
};

// Demo-live — date-stamped so each demo gets a fresh incident
const todayISO = new Date().toISOString().slice(0, 10);
const LIVE = {
  incidentId: `demo-live-${todayISO}`,
  title: `Fiber splice — Site Birch Run · Central vault (${todayISO})`,
  revenue: 4200,
};

// ── HTTP helpers ──────────────────────────────────────────────────
async function postFn(name, body) {
  const r = await fetch(`${FN_BASE}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "demo-seed/1.0" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  if (VERBOSE) console.log(`  POST ${name} → ${r.status} ${typeof json === "object" ? JSON.stringify(json).slice(0, 200) : text.slice(0, 200)}`);
  return { status: r.status, body: json || text };
}

async function getFn(name, query) {
  const qs = new URLSearchParams(query).toString();
  const r = await fetch(`${FN_BASE}/${name}?${qs}`);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text };
}

function logStep(msg) { console.log(`  · ${msg}`); }
function logSection(msg) { console.log(`\n── ${msg} ${"─".repeat(Math.max(0, 65 - msg.length))}`); }

// ── Prereq validation ─────────────────────────────────────────────
async function validatePrereqs() {
  logSection("Validating prereqs");

  const orgSnap = await db.doc(`orgs/${ORG_ID}`).get();
  if (!orgSnap.exists) {
    throw new Error(`Org "${ORG_ID}" does not exist. See docs/DEMO_SETUP_ORG.md.`);
  }
  logStep(`org "${ORG_ID}" exists`);

  for (const uid of [ADMIN_UID, COORDINATOR_UID, FOREMAN_UID]) {
    const m = await db.doc(`orgs/${ORG_ID}/members/${uid}`).get();
    if (!m.exists) {
      throw new Error(`Member "${uid}" not in org "${ORG_ID}". See docs/DEMO_SETUP_ORG.md.`);
    }
    const role = String((m.data() || {}).role || "");
    logStep(`member ${uid} role=${role}`);
  }
}

// ── Template upsert ───────────────────────────────────────────────
async function ensureDemoTemplate() {
  logSection("Demo template");
  const ref = db.doc(`orgs/${ORG_ID}/templates/${TEMPLATE_KEY}`);
  const snap = await ref.get();
  if (snap.exists) {
    logStep(`template ${TEMPLATE_KEY} already exists`);
    return;
  }
  await ref.set({
    templateKey: TEMPLATE_KEY,
    customerLabel: CUSTOMER_LABEL,
    archetype: ARCHETYPE,
    version: TEMPLATE_VERSION,
    // Deliberately MISSING "OTDR trace" from required proof. That's the
    // gap the demo surfaces in stage 11.
    requiredProof: ["Splice macro photo", "Splice closure photo"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [
      { type: "requires_supervisor_approval", tier: "required", label: "Field supervisor signoff" },
    ],
    requiredProofDescriptions: [
      "Macro shot of the splice with slate label visible",
      "Wide shot of the closure dome before sealing",
    ],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: ADMIN_UID,
    updatedBy: ADMIN_UID,
  });
  logStep(`created template ${TEMPLATE_KEY} v${TEMPLATE_VERSION}`);
}

// ── Static seed: incident + jobs + evidence (direct Firestore) ────
// Mirrors the smoke harness pattern. Direct writes are acceptable for
// setup data; all state TRANSITIONS go through HTTP endpoints.
async function seedIncidentStatic({ incidentId, title }) {
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).set({
    orgId: ORG_ID,
    incidentId,
    title,
    customer: CUSTOMER_LABEL,
    archetype: ARCHETYPE,
    status: "in_progress",
    requirements: {
      templateKey: TEMPLATE_KEY,
      templateVersion: TEMPLATE_VERSION,
      customerLabel: CUSTOMER_LABEL,
      archetype: ARCHETYPE,
      requiredProof: ["Splice macro photo", "Splice closure photo"],
      requiredProofDescriptions: ["Macro shot", "Closure shot"],
      optionalProof: [],
      acceptanceCriteria: [],
      acceptanceChecks: [
        { type: "requires_supervisor_approval", tier: "required", label: "QA signoff" },
      ],
    },
    readinessCache: { ready: true, label: "Ready", checks: [] },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  // Legacy jobs path (createJobV1 hardcodes here per session memory)
  await db.doc(`incidents/${incidentId}/jobs/job-1`).set({
    id: "job-1",
    incidentId,
    title: title,
    status: "approved",
    reviewStatus: "approved",
    estimatedRevenue: 4200,  // forward-compat for PR 131a revenue suggestion
  }, { merge: true });
}

async function seedEvidenceShells(incidentId) {
  // Two evidence shells matching the template's required slots.
  for (const [evId, slot] of [["splice-macro", "Splice macro photo"], ["closure-dome", "Splice closure photo"]]) {
    await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}/evidence_locker/${evId}`).set({
      filename: `${evId}.jpg`,
      caption: slot,
      slot,
      capturedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}

// ── Reset path: abandon all non-terminal recovery cases ───────────
const TERMINAL_STATUSES = new Set(["recovered", "partial_recovery", "abandoned", "expired"]);

async function abandonOpenCases() {
  logSection("Abandoning open recovery cases");
  const snap = await db.collection(`orgs/${ORG_ID}/recovery_cases`).get();
  const openCases = snap.docs.filter((d) => !TERMINAL_STATUSES.has(String((d.data() || {}).status || "")));
  if (openCases.length === 0) {
    logStep("no open cases to abandon");
    return;
  }
  for (const doc of openCases) {
    const caseId = doc.id;
    const r = await postFn("updateRecoveryCaseV1", {
      actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
      status: "abandoned",
      resolution: { outcome: "abandoned", notes: "Demo reset" },
    });
    if (r.status !== 200) {
      console.error(`  ! failed to abandon case ${caseId}: ${r.status} ${JSON.stringify(r.body).slice(0, 150)}`);
    } else {
      logStep(`abandoned case ${caseId} (was ${doc.data().status})`);
    }
    await sleep(150);
  }
}

// ── Walk a full historical reject→recovery→accept cycle ───────────
async function walkHistoricalCycle({ incidentId, rejectComment, revenue }) {
  logStep(`incident ${incidentId} (rejects with: "${rejectComment}")`);

  // Idempotency check: if a recovered case for this incident already exists
  // with the right comment, skip the walk.
  const existingCase = await db.collection(`orgs/${ORG_ID}/recovery_cases`)
    .where("incidentId", "==", incidentId).limit(1).get();
  if (!existingCase.empty) {
    const data = existingCase.docs[0].data();
    if (data.status === "recovered") {
      logStep(`    already recovered (caseId=${existingCase.docs[0].id}); skipping`);
      return;
    }
    // If a non-terminal case from a prior partial run exists, the reset
    // path already abandoned it. We can continue with a fresh cycle.
  }

  // 1. Seed static incident + jobs + evidence
  await seedIncidentStatic({ incidentId, title: `Fiber splice — ${incidentId}` });
  await seedEvidenceShells(incidentId);

  // 2. Mint customer review v1
  const mint1 = await postFn("createCustomerReviewLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, incidentId,
  });
  if (mint1.status !== 200) throw new Error(`mint v1 failed: ${mint1.status} ${JSON.stringify(mint1.body).slice(0, 200)}`);

  // 3. Customer rejects → auto-creates case, infers cause
  const rej1 = await postFn("submitCustomerReviewV1", {
    token: mint1.body.token, action: "reject", comment: rejectComment,
  });
  if (rej1.status !== 200) throw new Error(`reject v1 failed: ${rej1.status}`);

  // 4. Find the auto-created case
  await sleep(500);  // give the inline auto-handler a beat
  const caseSnap = await db.collection(`orgs/${ORG_ID}/recovery_cases`)
    .where("incidentId", "==", incidentId).limit(1).get();
  if (caseSnap.empty) throw new Error(`no case auto-created for ${incidentId}`);
  const caseId = caseSnap.docs[0].id;

  // 5. Set revenue + move to in_progress
  await postFn("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    revenueAtRisk: { amount: revenue, type: "actual" },
  });
  await postFn("updateRecoveryCaseV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, status: "in_progress",
  });

  // 6. Complete the starter action (auto-created with type=clarify_with_customer)
  const actsSnap = await db.collection(`orgs/${ORG_ID}/recovery_cases/${caseId}/actions`).get();
  const starter = actsSnap.docs[0];
  if (!starter) throw new Error(`no starter action for case ${caseId}`);

  // 7. Add a provide_test_results action (the cause-suggested one)
  const addAct = await postFn("addRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    type: "provide_test_results",
    title: "Provide OTDR trace",
    assigneeRole: "field_lead",
  });
  if (addAct.status !== 200) throw new Error(`addRecoveryActionV1 failed: ${addAct.status}`);

  // 8. Complete both actions
  await postFn("updateRecoveryActionV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId, actionId: starter.id,
    status: "done", outcome: "Clarified",
  });
  await postFn("updateRecoveryActionV1", {
    actorUid: FOREMAN_UID, orgId: ORG_ID, caseId, actionId: addAct.body.actionId,
    status: "done", outcome: "OTDR trace captured and attached",
  });

  // 9. Auto-flip happened; mint v2
  await sleep(500);
  // Reset incident.status so createCustomerReviewLinkV1 path is also unblocked
  // (mintResubmissionLinkV1 also flips it — kept here for safety)
  const mint2 = await postFn("mintResubmissionLinkV1", {
    actorUid: ADMIN_UID, orgId: ORG_ID, caseId,
    changeSummary: "Captured OTDR trace as requested.",
  });
  if (mint2.status !== 200) throw new Error(`mint v2 failed: ${mint2.status} ${JSON.stringify(mint2.body).slice(0, 200)}`);

  // 10. Customer accepts v2 → case → recovered
  const acc = await postFn("submitCustomerReviewV1", {
    token: mint2.body.token, action: "accept", comment: "Looks good",
  });
  if (acc.status !== 200) throw new Error(`accept v2 failed: ${acc.status}`);

  await sleep(300);
  logStep(`    ✓ recovered ($${revenue})`);
}

// ── Seed the demo-live incident (presenter walks it during demo) ──
async function seedDemoLive({ incidentId, title }) {
  logSection(`Demo-live incident: ${incidentId}`);

  // Check if already exists
  const inc = await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).get();
  if (inc.exists && String((inc.data() || {}).status || "") === "in_progress") {
    logStep(`already exists in in_progress state; ready for presenter`);
    return;
  }

  await seedIncidentStatic({ incidentId, title });
  await seedEvidenceShells(incidentId);
  logStep(`created at in_progress with required proof. Ready for stage 4 mint.`);
}

// ── Refresh: check historical age, recreate if needed ─────────────
async function refresh() {
  logSection("Refresh check");
  const cutoffMs = Date.now() - 20 * 24 * 60 * 60 * 1000;
  for (const hist of [HIST_1, HIST_2]) {
    const snap = await db.collection(`orgs/${ORG_ID}/recovery_cases`)
      .where("incidentId", "==", hist.incidentId).limit(1).get();
    if (snap.empty) {
      logStep(`${hist.incidentId}: no case exists; will be created by seed`);
      continue;
    }
    const data = snap.docs[0].data();
    const openedAt = data.openedAt;
    const openedMs = openedAt?.toDate?.()?.getTime?.() || 0;
    if (openedMs < cutoffMs) {
      logStep(`${hist.incidentId}: opened ${Math.round((Date.now() - openedMs) / (24*60*60*1000))}d ago — REFRESHING`);
      // Abandon any non-terminal then recreate with new dated incidentId
      // For simplicity in refresh, we re-walk against the SAME incidentId,
      // but the new audit rows will be dated NOW (which is what counts
      // for the 30-day window).
      // Note: this creates a 2nd case for the same incidentId since the
      // first is recovered (terminal). PR 129a allows new case creation
      // when prior is terminal.
      await walkHistoricalCycle(hist);
    } else {
      logStep(`${hist.incidentId}: opened ${Math.round((Date.now() - openedMs) / (24*60*60*1000))}d ago — within window`);
    }
  }
}

// ── Print demo URLs ───────────────────────────────────────────────
async function printDemoURLs() {
  logSection("Demo URLs");
  console.log(`
  ADMIN tab (stages 1, 11):
    https://app.peakops.app/admin/templates/${TEMPLATE_KEY}?orgId=${ORG_ID}

  COORDINATOR tab (stages 4, 6, 7, 9):
    https://app.peakops.app/recovery?orgId=${ORG_ID}
    + opens the demo-live case at stage 6 (auto-fills from queue)

  FOREMAN tab (stages 2, 3, 8):
    https://app.peakops.app/incidents/${LIVE.incidentId}?orgId=${ORG_ID}

  CUSTOMER tab (stages 5, 10):
    Mint token live in stage 4 via the coordinator's "Send to customer" button.
    Stage 4 produces a URL like:
      https://app.peakops.app/review/<TOKEN>
    Paste that URL into an incognito browser for stage 5.
    Stage 9 produces a v2 URL the same way; paste into incognito for stage 10.

  Reset before next demo:
    node scripts/dev/seed_demo_recovery.mjs --org ${ORG_ID} --action reset
`);
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`Demo seed: org=${ORG_ID} action=${ACTION} project=${PROJECT}`);
  await validatePrereqs();

  if (ACTION === "reset") {
    await abandonOpenCases();
    console.log("\nReset complete. Recovered cases preserved (still counting toward 30-day window).");
    return;
  }

  if (ACTION === "refresh") {
    await refresh();
    console.log("\nRefresh complete.");
    return;
  }

  // seed: full setup
  await ensureDemoTemplate();
  await abandonOpenCases();

  logSection("Historical cycle 1 (Acme rejection — OTDR)");
  await walkHistoricalCycle(HIST_1);

  logSection("Historical cycle 2 (Acme rejection — test results)");
  await walkHistoricalCycle(HIST_2);

  await seedDemoLive(LIVE);

  await printDemoURLs();
  console.log("\nSeed complete. Ready for demo.");
}

main().catch((e) => { console.error("Demo seed FAILED:", e?.message || e); process.exit(2); });
