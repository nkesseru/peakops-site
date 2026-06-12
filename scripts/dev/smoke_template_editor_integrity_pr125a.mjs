#!/usr/bin/env node
// PR 125a — Template Editor Integrity backend smoke harness.
//
// Verifies the new getOrgTemplateV1 callable + the explicit-templateKey
// edit path in saveOrgTemplateV1 over the firebase functions emulator.
//
// Scenarios:
//   1. getOrgTemplateV1 returns full doc for existing template (admin)
//   2. getOrgTemplateV1 returns 404 for non-existent templateKey
//   3. getOrgTemplateV1 returns 403 for non-admin role
//   4. Edit path: save with explicit templateKey lands on right doc,
//      increments version
//   5. Identity preservation: edit path with empty customerLabel keeps
//      original identity (doesn't drop to org-wide)
//   6. Edit path: explicit templateKey to non-existent doc → 404
//   7. Edit path: archetype mismatch → 400
//   8. Create path unchanged: no templateKey in body still derives
//   9. Round-trip: save with descriptions/reasons, getOrgTemplateV1
//      returns them back exactly
//   10. Audit row records explicitTemplateKey=true for edit path
//
// Run via: scripts/dev/run_smoke_template_editor_integrity_pr125a.sh

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT_ID = process.env.PROJECT_ID || "peakops-emu-smoke";
const REGION = process.env.REGION || "us-central1";
const FN_HOST = process.env.FN_HOST || "127.0.0.1:5004";
const FN_BASE = `http://${FN_HOST}/${PROJECT_ID}/${REGION}`;

const ORG_ID = "smoke-org-pr125a";
const ADMIN_UID = "smoke-admin";
const FIELD_UID = "smoke-field";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

async function seedOrgAndMembers() {
  await db.doc(`orgs/${ORG_ID}`).set({ name: "PR125a Smoke Org", createdAt: FieldValue.serverTimestamp() });
  await db.doc(`orgs/${ORG_ID}/members/${ADMIN_UID}`).set({ role: "admin", status: "active" });
  await db.doc(`orgs/${ORG_ID}/members/${FIELD_UID}`).set({ role: "field", status: "active" });
}

async function postJson(name, body) {
  const res = await fetch(`${FN_BASE}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: res.status, body: json || text };
}

async function getJson(name, query) {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${FN_BASE}/${name}?${qs}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: res.status, body: json || text };
}

async function readTemplate(templateKey) {
  const snap = await db.doc(`orgs/${ORG_ID}/templates/${templateKey}`).get();
  return snap.exists ? snap.data() : null;
}

async function readAuditTail() {
  const q = await db.collection(`orgs/${ORG_ID}/admin_audit`).orderBy("createdAt", "desc").limit(1).get();
  return q.docs[0]?.data() || null;
}

async function seedBaseTemplate() {
  // Seed via the existing create path so we have a v1 to edit.
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    archetype: "fiber_splice_verification",
    customerLabel: "Comcast Restoration",
    requiredProof: ["Splice enclosure photo", "Fiber labeling photo"],
    requiredProofDescriptions: ["Wide shot of the sealed enclosure", "Close-up of the label"],
    optionalProof: ["OTDR trace"],
    acceptanceCriteria: ["Required photos uploaded"],
    acceptanceChecks: [
      { type: "requires_supervisor_approval", tier: "required", label: "Comcast QA signoff" },
      { type: "requires_field_notes", tier: "required" },
    ],
    changeNote: "Seed v1",
  });
  if (res.status !== 200 || !res.body?.ok) {
    throw new Error(`seedBaseTemplate failed: ${res.status} ${JSON.stringify(res.body).slice(0,200)}`);
  }
  return res.body.templateKey;
}

// ── scenarios ──────────────────────────────────────────────────────

async function s1_getReturnsFullDoc() {
  const name = "1) getOrgTemplateV1 returns full doc for existing template (admin)";
  const templateKey = `fiber_splice_verification__comcast-restoration`;
  const res = await getJson("getOrgTemplateV1", { orgId: ORG_ID, templateKey, actorUid: ADMIN_UID });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  const t = res.body.template;
  if (!t) return { name, pass: false, detail: "template missing in response" };
  if (t.templateKey !== templateKey) return { name, pass: false, detail: `templateKey=${t.templateKey}` };
  if (t.archetype !== "fiber_splice_verification") return { name, pass: false, detail: `archetype=${t.archetype}` };
  if (t.customerSlug !== "comcast-restoration") return { name, pass: false, detail: `customerSlug=${t.customerSlug}` };
  if (t.customerLabel !== "Comcast Restoration") return { name, pass: false, detail: `customerLabel=${t.customerLabel}` };
  if (!Array.isArray(t.requiredProof) || t.requiredProof.length !== 2) return { name, pass: false, detail: `requiredProof.length=${t.requiredProof?.length}` };
  if (!Array.isArray(t.requiredProofDescriptions) || t.requiredProofDescriptions.length !== 2) {
    return { name, pass: false, detail: `requiredProofDescriptions.length=${t.requiredProofDescriptions?.length}` };
  }
  if (t.requiredProofDescriptions[0] !== "Wide shot of the sealed enclosure") {
    return { name, pass: false, detail: `requiredProofDescriptions[0]=${t.requiredProofDescriptions[0]}` };
  }
  if (!Array.isArray(t.optionalProof) || t.optionalProof.length !== 1) return { name, pass: false, detail: `optionalProof.length=${t.optionalProof?.length}` };
  if (!Array.isArray(t.acceptanceChecks) || t.acceptanceChecks.length !== 2) return { name, pass: false, detail: `acceptanceChecks.length=${t.acceptanceChecks?.length}` };
  if (t.version !== 1) return { name, pass: false, detail: `version=${t.version}` };
  if (!t.createdAt) return { name, pass: false, detail: "createdAt missing" };
  if (!t.createdBy) return { name, pass: false, detail: "createdBy missing" };
  return { name, pass: true, detail: `full doc returned: arrays + provenance + reasons` };
}

async function s2_getReturns404ForMissing() {
  const name = "2) getOrgTemplateV1 returns 404 for non-existent templateKey";
  const res = await getJson("getOrgTemplateV1", {
    orgId: ORG_ID,
    templateKey: "fiber_splice_verification__no-such-customer",
    actorUid: ADMIN_UID,
  });
  if (res.status !== 404) return { name, pass: false, detail: `expected 404; got ${res.status}` };
  if (res.body?.error !== "template_not_found") return { name, pass: false, detail: `error=${res.body?.error}` };
  return { name, pass: true, detail: `404 template_not_found as expected` };
}

async function s3_getDeniedForNonAdmin() {
  const name = "3) getOrgTemplateV1 returns 403 for non-admin role";
  const templateKey = `fiber_splice_verification__comcast-restoration`;
  const res = await getJson("getOrgTemplateV1", { orgId: ORG_ID, templateKey, actorUid: FIELD_UID });
  if (res.status !== 403) return { name, pass: false, detail: `expected 403; got ${res.status}` };
  if (res.body?.error !== "permission-denied") return { name, pass: false, detail: `error=${res.body?.error}` };
  return { name, pass: true, detail: `403 permission-denied for field role` };
}

async function s4_editPathWithExplicitKey() {
  const name = "4) Edit path: save with explicit templateKey lands on right doc and bumps version";
  const templateKey = `fiber_splice_verification__comcast-restoration`;
  const before = await readTemplate(templateKey);
  if (before?.version !== 1) return { name, pass: false, detail: `precondition: prior version should be 1 (got ${before?.version})` };

  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    templateKey,                                // EXPLICIT — edit path
    archetype: "fiber_splice_verification",
    customerLabel: "Comcast Restoration",
    requiredProof: ["Splice enclosure photo", "Fiber labeling photo", "Vault context photo"],
    requiredProofDescriptions: ["Wide shot", "Label close-up", "Vault context"],
    optionalProof: ["OTDR trace"],
    acceptanceCriteria: ["Required photos uploaded"],
    acceptanceChecks: [
      { type: "requires_supervisor_approval", tier: "required", label: "Comcast QA signoff" },
      { type: "requires_field_notes", tier: "required" },
    ],
    changeNote: "Added vault context proof",
  });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  if (res.body.templateKey !== templateKey) return { name, pass: false, detail: `response templateKey=${res.body.templateKey}` };
  if (res.body.version !== 2) return { name, pass: false, detail: `version=${res.body.version}` };

  const after = await readTemplate(templateKey);
  if (after.version !== 2) return { name, pass: false, detail: `doc version=${after.version}` };
  if (after.requiredProof.length !== 3) return { name, pass: false, detail: `requiredProof.length=${after.requiredProof.length}` };

  // Org-wide template at archetype-only key MUST NOT have been touched.
  const orgWide = await readTemplate("fiber_splice_verification");
  if (orgWide) return { name, pass: false, detail: `unexpected org-wide doc created at "fiber_splice_verification"` };

  return { name, pass: true, detail: `v1 → v2 on right templateKey; no stray org-wide doc` };
}

async function s5_editPathPreservesIdentityOnEmptyLabel() {
  const name = "5) Edit path with empty customerLabel preserves identity (no fallback to org-wide)";
  const templateKey = `fiber_splice_verification__comcast-restoration`;
  const before = await readTemplate(templateKey);
  if (before?.version !== 2) return { name, pass: false, detail: `precondition: prior version should be 2 (got ${before?.version})` };

  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    templateKey,                                // EXPLICIT
    archetype: "fiber_splice_verification",
    customerLabel: "",                          // empty (legacy doc, disabled input, etc.)
    requiredProof: ["Splice enclosure photo", "Fiber labeling photo", "Vault context photo"],
    requiredProofDescriptions: ["Wide shot", "Label close-up", "Vault context"],
    optionalProof: ["OTDR trace"],
    acceptanceCriteria: ["Required photos uploaded"],
    acceptanceChecks: [
      { type: "requires_supervisor_approval", tier: "required", label: "Comcast QA signoff" },
      { type: "requires_field_notes", tier: "required" },
    ],
    changeNote: "Empty label test",
  });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  if (res.body.templateKey !== templateKey) return { name, pass: false, detail: `response templateKey=${res.body.templateKey}` };
  if (res.body.version !== 3) return { name, pass: false, detail: `version=${res.body.version}` };

  const after = await readTemplate(templateKey);
  // CRITICAL: identity preserved — customerSlug + customerLabel inherited from prior doc.
  if (after.customerSlug !== "comcast-restoration") return { name, pass: false, detail: `customerSlug dropped: ${after.customerSlug}` };
  if (after.customerLabel !== "Comcast Restoration") return { name, pass: false, detail: `customerLabel dropped: ${after.customerLabel}` };

  // Org-wide template at archetype-only key MUST NOT have been touched.
  const orgWide = await readTemplate("fiber_splice_verification");
  if (orgWide) return { name, pass: false, detail: `unexpected org-wide doc created at "fiber_splice_verification"` };

  return { name, pass: true, detail: `identity preserved (customerSlug=${after.customerSlug}, customerLabel=${after.customerLabel}); no org-wide doc` };
}

async function s6_editPathMissingTargetIs404() {
  const name = "6) Edit path: explicit templateKey to non-existent doc → 404 template_not_found";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    templateKey: "fiber_splice_verification__ghost-customer",   // doesn't exist
    archetype: "fiber_splice_verification",
    customerLabel: "Ghost Customer",
    requiredProof: ["anything"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
    changeNote: "Trying to save into a non-existent template",
  });
  if (res.status !== 404) return { name, pass: false, detail: `expected 404; got ${res.status}` };
  if (res.body?.error !== "template_not_found") return { name, pass: false, detail: `error=${res.body?.error}` };

  // Confirm no doc was created at that key.
  const ghost = await readTemplate("fiber_splice_verification__ghost-customer");
  if (ghost) return { name, pass: false, detail: `404 path leaked a doc into Firestore` };

  return { name, pass: true, detail: `404 template_not_found; no doc created` };
}

async function s7_editPathArchetypeMismatch() {
  const name = "7) Edit path: archetype mismatch → 400 archetype_mismatch";
  const templateKey = `fiber_splice_verification__comcast-restoration`;
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    templateKey,
    archetype: "storm_restoration_proof",       // doesn't match the existing doc
    customerLabel: "Comcast Restoration",
    requiredProof: ["whatever"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if (res.status !== 400) return { name, pass: false, detail: `expected 400; got ${res.status}` };
  if (res.body?.error !== "archetype_mismatch") return { name, pass: false, detail: `error=${res.body?.error}` };

  // The existing doc must remain unchanged.
  const after = await readTemplate(templateKey);
  if (after.archetype !== "fiber_splice_verification") return { name, pass: false, detail: `archetype drifted: ${after.archetype}` };
  if (after.version !== 3) return { name, pass: false, detail: `version drifted: ${after.version}` };

  return { name, pass: true, detail: `400 archetype_mismatch; doc unchanged` };
}

async function s8_createPathUnchanged() {
  const name = "8) Create path unchanged: no templateKey in body → derives from archetype + customerLabel";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    // no templateKey — create path
    archetype: "site_acceptance",
    customerLabel: "Acme Networks",
    requiredProof: ["Site photo"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
    changeNote: "Created via create path",
  });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  if (res.body.templateKey !== "site_acceptance__acme-networks") return { name, pass: false, detail: `templateKey=${res.body.templateKey}` };
  if (res.body.version !== 1) return { name, pass: false, detail: `version=${res.body.version}` };
  if (!res.body.isCreate) return { name, pass: false, detail: "isCreate should be true" };

  const doc = await readTemplate("site_acceptance__acme-networks");
  if (!doc) return { name, pass: false, detail: "doc missing at derived key" };
  if (doc.customerSlug !== "acme-networks") return { name, pass: false, detail: `customerSlug=${doc.customerSlug}` };
  if (doc.customerLabel !== "Acme Networks") return { name, pass: false, detail: `customerLabel=${doc.customerLabel}` };

  return { name, pass: true, detail: `create path still derives templateKey correctly` };
}

async function s9_roundTripPreservesAllArrays() {
  const name = "9) Round-trip save → getOrgTemplateV1 returns identical arrays + reasons";
  const templateKey = `fiber_splice_verification__comcast-restoration`;
  // Save with a specific shape we'll check exactly on the next get.
  const saveRes = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    templateKey,
    archetype: "fiber_splice_verification",
    customerLabel: "Comcast Restoration",
    requiredProof: ["RP-1", "RP-2", "RP-3"],
    requiredProofDescriptions: ["Reason A", "Reason B", "Reason C"],
    optionalProof: ["OP-1", "OP-2"],
    acceptanceCriteria: ["AC-1"],
    acceptanceChecks: [
      { type: "requires_supervisor_approval", tier: "required", label: "Round-trip check", description: "Round-trip description" },
      { type: "requires_field_notes", tier: "encouraged" },
    ],
    changeNote: "Round-trip test",
  });
  if (saveRes.status !== 200 || !saveRes.body?.ok) return { name, pass: false, detail: `save: ${saveRes.status}` };

  const getRes = await getJson("getOrgTemplateV1", { orgId: ORG_ID, templateKey, actorUid: ADMIN_UID });
  if (getRes.status !== 200 || !getRes.body?.ok) return { name, pass: false, detail: `get: ${getRes.status}` };
  const t = getRes.body.template;
  if (JSON.stringify(t.requiredProof) !== JSON.stringify(["RP-1", "RP-2", "RP-3"])) return { name, pass: false, detail: `requiredProof=${JSON.stringify(t.requiredProof)}` };
  if (JSON.stringify(t.requiredProofDescriptions) !== JSON.stringify(["Reason A", "Reason B", "Reason C"])) {
    return { name, pass: false, detail: `requiredProofDescriptions=${JSON.stringify(t.requiredProofDescriptions)}` };
  }
  if (JSON.stringify(t.optionalProof) !== JSON.stringify(["OP-1", "OP-2"])) return { name, pass: false, detail: `optionalProof=${JSON.stringify(t.optionalProof)}` };
  if (JSON.stringify(t.acceptanceCriteria) !== JSON.stringify(["AC-1"])) return { name, pass: false, detail: `acceptanceCriteria=${JSON.stringify(t.acceptanceCriteria)}` };
  if (t.acceptanceChecks.length !== 2) return { name, pass: false, detail: `acceptanceChecks.length=${t.acceptanceChecks.length}` };
  if (t.acceptanceChecks[0].label !== "Round-trip check") return { name, pass: false, detail: `check[0].label=${t.acceptanceChecks[0].label}` };
  if (t.acceptanceChecks[0].description !== "Round-trip description") return { name, pass: false, detail: `check[0].description=${t.acceptanceChecks[0].description}` };

  return { name, pass: true, detail: `round-trip exact: arrays + reasons + check label/description` };
}

async function s10_auditRecordsExplicitFlag() {
  const name = "10) Audit row records explicitTemplateKey=true for edit-path saves";
  const audit = await readAuditTail();
  if (audit?.type !== "template_saved") return { name, pass: false, detail: `audit.type=${audit?.type}` };
  if (audit?.templateKey !== "fiber_splice_verification__comcast-restoration") return { name, pass: false, detail: `audit.templateKey=${audit?.templateKey}` };
  if (audit?.explicitTemplateKey !== true) return { name, pass: false, detail: `audit.explicitTemplateKey=${audit?.explicitTemplateKey}` };
  if (audit?.changeNote !== "Round-trip test") return { name, pass: false, detail: `audit.changeNote=${audit?.changeNote}` };
  return { name, pass: true, detail: `audit row carries explicitTemplateKey=true for edit-path save` };
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] PROJECT=${PROJECT_ID} FN_BASE=${FN_BASE}`);
  await sleep(500);
  console.log("[smoke] seeding org + members");
  await seedOrgAndMembers();
  console.log("[smoke] seeding base template (v1)");
  await seedBaseTemplate();

  const scenarios = [
    s1_getReturnsFullDoc,
    s2_getReturns404ForMissing,
    s3_getDeniedForNonAdmin,
    s4_editPathWithExplicitKey,
    s5_editPathPreservesIdentityOnEmptyLabel,
    s6_editPathMissingTargetIs404,
    s7_editPathArchetypeMismatch,
    s8_createPathUnchanged,
    s9_roundTripPreservesAllArrays,
    s10_auditRecordsExplicitFlag,
  ];
  const results = [];
  for (const fn of scenarios) {
    try {
      const r = await fn();
      results.push(r);
      console.log(`${r.pass ? "✓" : "✗"} ${r.name} — ${r.detail}`);
    } catch (e) {
      const r = { name: fn.name, pass: false, detail: `THREW ${e?.message || e}` };
      results.push(r);
      console.log(`✗ ${r.name} — ${r.detail}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log("──────────────────────────────");
  console.log(`${passed === results.length ? "PASS" : "FAIL"}: ${passed}/${results.length}`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("[smoke] unhandled:", e); process.exit(2); });
