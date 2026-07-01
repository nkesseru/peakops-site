#!/usr/bin/env node
// scripts/dev/seed_northline_demo.mjs
// Seeds the Northline Fiber demo incident on peakops-pilot for the
// Cascade Broadband story.
//
// Prerequisites — one-time setup, run this from CLI first:
//
//   FIREBASE_ID_TOKEN=<internal-admin ID token> \
//   node scripts/activateCustomerOrg.cjs \
//     --name="Northline Fiber Services" \
//     --industry=telecom \
//     --admin-email=demo-owner@peakops.app \
//     --admin-name="Demo Owner" \
//     --timezone="America/Los_Angeles" \
//     --teammate=demo-tech@peakops.app:field \
//     --teammate=demo-sup@peakops.app:supervisor \
//     --apply
//
// Then to seed the demo incident (repeatable):
//
//   GOOGLE_APPLICATION_CREDENTIALS=/Users/kesserumini/peakops/my-app/.secrets/sa.json \
//   node scripts/dev/seed_northline_demo.mjs
//
// If a prior demo run left evidence / jobs / timeline / recovery
// state behind, reset first (idempotent, safe on empty state too):
//
//   node scripts/dev/reset_northline_demo.mjs
//
// What this seeds (see project_demo_northline_fiber memory for full
// story context):
//   - Op 2 — Tags orgs/northline-fiber-services with demo: true
//   - Op 3 — Cascade-specific customer template with 6 required
//            proofs INCLUDING 1550 nm OTDR trace as required (the
//            demo hero — the rejection story hinges on OTDR).
//   - Op 4 — START-state incident: status="open", requirements
//            snapshot frozen, readinessCache="requirements_missing",
//            zero jobs / evidence / timeline. Ready for a live field-
//            tech capture walk.
//
// SCOPE (safety):
//   Writes ONLY to:
//     - orgs/northline-fiber-services                       (merge)
//     - orgs/northline-fiber-services/templates/<key>       (set)
//     - incidents/northline_demo_hh2247                     (set)
//     - orgs/northline-fiber-services/incidents/<id>        (set)
//   Nothing outside northline-fiber-services scope + its top-level
//   incident twin. Does NOT touch peakops-internal-alpha or any
//   other org. Does NOT touch shared collections.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const ORG_ID = "northline-fiber-services";
const INCIDENT_ID = "northline_demo_hh2247";
const CUSTOMER_SLUG = "cascade-broadband";
const TEMPLATE_KEY = `fiber_splice_verification__${CUSTOMER_SLUG}`;

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

// ── Template data (Op 3 + frozen onto incident.requirements in Op 4) ──
const REQUIRED_PROOF = [
  { key: "site-arrival-photo",             label: "Site arrival photo",              type: "photo" },
  { key: "splice-enclosure-before-photo",  label: "Splice enclosure — before photo", type: "photo" },
  { key: "splice-enclosure-after-photo",   label: "Splice enclosure — after photo",  type: "photo" },
  { key: "fiber-label-photo",              label: "Fiber labeling / tag photo",      type: "photo" },
  { key: "gps-tagged-completion-photo",    label: "GPS-tagged completion photo",     type: "photo" },
  // Demo hero: 1550 nm OTDR trace is REQUIRED on the Cascade template.
  // The starter fiber_splice_verification template ships OTDR as
  // optional; we promote it here so the rejection story is real and
  // the block-mode capture gate refuses submission until it's in.
  { key: "otdr-trace-1550nm",              label: "1550 nm OTDR trace",              type: "photo" },
];
const OPTIONAL_PROOF = [
  { key: "splice-tray-closeup",   label: "Splice tray close-up",   type: "photo" },
  { key: "loss-reading-printout", label: "Loss reading printout",  type: "photo" },
];
const ACCEPTANCE_CHECKS = [
  { key: "requires_minimum_proof_count",    tier: "required",   params: { minCount: 5 } },
  { key: "requires_supervisor_approval",    tier: "required" },
  { key: "requires_at_least_one_gps_proof", tier: "required" },
  { key: "requires_field_notes",            tier: "encouraged" },
  { key: "requires_incident_closure",       tier: "required" },
];

// ── Op 1 — sanity: org must exist ──
async function opSanity() {
  const snap = await db.doc(`orgs/${ORG_ID}`).get();
  if (!snap.exists) {
    console.error("");
    console.error("✗ Org 'northline-fiber-services' does NOT exist on peakops-pilot.");
    console.error("  This seed script does not create the org — the one-time");
    console.error("  activateCustomerOrg.cjs CLI does. Run it first:");
    console.error("");
    console.error("    FIREBASE_ID_TOKEN=<internal-admin token> \\");
    console.error("    node scripts/activateCustomerOrg.cjs \\");
    console.error("      --name=\"Northline Fiber Services\" \\");
    console.error("      --industry=telecom \\");
    console.error("      --admin-email=demo-owner@peakops.app \\");
    console.error("      --admin-name=\"Demo Owner\" \\");
    console.error("      --timezone=\"America/Los_Angeles\" \\");
    console.error("      --teammate=demo-tech@peakops.app:field \\");
    console.error("      --teammate=demo-sup@peakops.app:supervisor \\");
    console.error("      --apply");
    console.error("");
    console.error("  Then re-run this seed script.");
    console.error("");
    process.exit(1);
  }
  console.log(`✓ Op 1 — orgs/${ORG_ID} exists`);
}

// ── Op 2 — tag org as demo (idempotent merge) ──
async function opTagDemo() {
  await db.doc(`orgs/${ORG_ID}`).set({
    demo: true,
    demoNotes: "Northline Fiber demo — Cascade Broadband story. See project_demo_northline_fiber memory.",
    demoSeededAt: FV.serverTimestamp(),
  }, { merge: true });
  console.log(`✓ Op 2 — demo:true tag merged onto orgs/${ORG_ID}`);
}

// ── Op 3 — Cascade-specific customer template ──
async function opWriteTemplate() {
  await db.doc(`orgs/${ORG_ID}/templates/${TEMPLATE_KEY}`).set({
    archetype: "fiber_splice_verification",
    customerLabel: "Cascade Broadband",
    customerSlug: CUSTOMER_SLUG,
    templateVersion: 1,
    requiredProof: REQUIRED_PROOF,
    optionalProof: OPTIONAL_PROOF,
    acceptanceChecks: ACCEPTANCE_CHECKS,
    createdAt: FV.serverTimestamp(),
    createdBy: "seed_northline_demo",
    source: "seed_script",
  });
  console.log(`✓ Op 3 — template written: orgs/${ORG_ID}/templates/${TEMPLATE_KEY} (${REQUIRED_PROOF.length} required, ${OPTIONAL_PROOF.length} optional, ${ACCEPTANCE_CHECKS.length} acceptance checks)`);
}

// ── Op 4 — START-state incident (dual-write, mirrors createIncidentV1) ──
async function opCreateIncident() {
  const body = {
    id: INCIDENT_ID,
    orgId: ORG_ID,
    title: "$8,400 · 12-count fiber splice closeout — HH-2247",
    status: "open",
    priority: "normal",
    archetype: "fiber_splice_verification",
    customer: "Cascade Broadband",
    customerSlug: CUSTOMER_SLUG,
    customerLabel: "Cascade Broadband",
    location: "Handhole HH-2247, Cedar St & 14th Ave",
    externalWorkOrderId: "WO-8400",
    notes: "Route 27 · daylight window closes 15:30 · 1550 nm OTDR certification required per Cascade template",
    createdAt: FV.serverTimestamp(),
    createdBy: "seed_northline_demo",
    updatedAt: FV.serverTimestamp(),
    requirements: {
      source: "customer_template",
      templateKey: TEMPLATE_KEY,
      templateVersion: 1,
      requiredProof: REQUIRED_PROOF,
      optionalProof: OPTIONAL_PROOF,
      acceptanceChecks: ACCEPTANCE_CHECKS,
      snapshottedAt: FV.serverTimestamp(),
    },
    readinessCache: {
      state: "requirements_missing",
      summary: `${REQUIRED_PROOF.length} required proof items missing; supervisor approval pending; incident open.`,
      checks: [],
      cachedAt: FV.serverTimestamp(),
    },
  };
  await db.doc(`incidents/${INCIDENT_ID}`).set(body);
  await db.doc(`orgs/${ORG_ID}/incidents/${INCIDENT_ID}`).set(body);
  console.log(`✓ Op 4 — incident dual-written: incidents/${INCIDENT_ID} + orgs/${ORG_ID}/incidents/${INCIDENT_ID}`);
}

// ── Op 5 — verify + summary ──
async function opVerify() {
  const snap = await db.doc(`orgs/${ORG_ID}/incidents/${INCIDENT_ID}`).get();
  if (!snap.exists) throw new Error("verify: incident missing after seed");
  const d = snap.data();
  const assertions = [
    [`status === "open"`,                                   d.status === "open"],
    [`requirements.source === "customer_template"`,         d.requirements?.source === "customer_template"],
    [`requirements.templateKey === "${TEMPLATE_KEY}"`,      d.requirements?.templateKey === TEMPLATE_KEY],
    [`requirements.requiredProof.length === 6`,             (d.requirements?.requiredProof || []).length === 6],
    [`otdr-trace-1550nm is a required proof slot`,          (d.requirements?.requiredProof || []).some((p) => p?.key === "otdr-trace-1550nm")],
    [`readinessCache.state === "requirements_missing"`,     d.readinessCache?.state === "requirements_missing"],
    [`no evidence yet`,                                     !(d.evidence && d.evidence.length)],
  ];
  let allPass = true;
  console.log("  Verify:");
  for (const [label, ok] of assertions) {
    console.log(`    ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) allPass = false;
  }
  if (!allPass) throw new Error("verify: one or more assertions failed");
  console.log(`✓ Op 5 — verified`);
}

(async () => {
  console.log("── Seeding Northline Fiber demo on peakops-pilot ──\n");
  await opSanity();
  await opTagDemo();
  await opWriteTemplate();
  await opCreateIncident();
  await opVerify();
  console.log("");
  console.log("✅ Demo ready.");
  console.log("");
  console.log(`   URL:   https://app.peakops.app/incidents/${INCIDENT_ID}?orgId=${ORG_ID}`);
  console.log("");
  console.log("   Tech:  demo-tech@peakops.app  (magic link from activateCustomerOrg output)");
  console.log("   Sup:   demo-sup@peakops.app");
  console.log("   Owner: demo-owner@peakops.app");
  console.log("");
  console.log("   Reset: node scripts/dev/reset_northline_demo.mjs");
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("SEED FAILED:", e?.message || e);
    if (e?.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  });
