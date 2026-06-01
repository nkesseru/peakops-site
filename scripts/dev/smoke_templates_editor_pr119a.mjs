#!/usr/bin/env node
// PR 119a — Acceptance Requirements Editor backend smoke harness.
//
// Verifies listOrgTemplatesV1 + saveOrgTemplateV1 over the real HTTP
// path through the firebase functions emulator.
//
// Run via: scripts/dev/run_smoke_templates_editor_pr119a.sh

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT_ID = process.env.PROJECT_ID || "peakops-emu-smoke";
const REGION = process.env.REGION || "us-central1";
const FN_HOST = process.env.FN_HOST || "127.0.0.1:5004";
const FN_BASE = `http://${FN_HOST}/${PROJECT_ID}/${REGION}`;

const ORG_ID = "smoke-org-pr119a";
const ADMIN_UID = "smoke-admin";
const FIELD_UID = "smoke-field";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

async function seedOrgAndMembers() {
  await db.doc(`orgs/${ORG_ID}`).set({ name: "PR119a Smoke Org", createdAt: FieldValue.serverTimestamp() });
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

// ── scenarios ──────────────────────────────────────────────────────

async function s1_createCustomerTemplate() {
  const name = "1) Create customer template (v1) + admin_audit append";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    archetype: "fiber_splice_verification",
    customerLabel: "Comcast Restoration",
    requiredProof: ["Splice enclosure photo", "Fiber labeling photo"],
    optionalProof: ["OTDR trace"],
    acceptanceCriteria: ["Required photos uploaded"],
    acceptanceChecks: [
      { type: "requires_supervisor_approval", tier: "required", label: "Comcast QA signoff" },
      { type: "requires_field_notes", tier: "required" },
    ],
    changeNote: "Initial Comcast restoration template",
  });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  if (res.body.version !== 1) return { name, pass: false, detail: `version=${res.body.version}` };
  if (!res.body.isCreate) return { name, pass: false, detail: "isCreate should be true on first save" };

  const expectedKey = `fiber_splice_verification__comcast-restoration`;
  if (res.body.templateKey !== expectedKey) return { name, pass: false, detail: `templateKey=${res.body.templateKey}` };

  // Verify Firestore doc
  const doc = await readTemplate(expectedKey);
  if (!doc) return { name, pass: false, detail: "template doc missing" };
  if (doc.version !== 1) return { name, pass: false, detail: `doc.version=${doc.version}` };
  if (doc.archetype !== "fiber_splice_verification") return { name, pass: false, detail: `doc.archetype=${doc.archetype}` };
  if (doc.customerSlug !== "comcast-restoration") return { name, pass: false, detail: `doc.customerSlug=${doc.customerSlug}` };
  if (doc.customerLabel !== "Comcast Restoration") return { name, pass: false, detail: `doc.customerLabel=${doc.customerLabel}` };
  if (doc.requiredProof.length !== 2) return { name, pass: false, detail: `doc.requiredProof.length=${doc.requiredProof.length}` };
  if (doc.acceptanceChecks.length !== 2) return { name, pass: false, detail: `doc.acceptanceChecks.length=${doc.acceptanceChecks.length}` };
  if (doc.acceptanceChecks[0].label !== "Comcast QA signoff") return { name, pass: false, detail: "first check label missing" };
  if (doc.createdBy !== ADMIN_UID) return { name, pass: false, detail: `createdBy=${doc.createdBy}` };
  if (doc.updatedBy !== ADMIN_UID) return { name, pass: false, detail: `updatedBy=${doc.updatedBy}` };

  // Verify admin_audit append
  const audit = await readAuditTail();
  if (audit?.type !== "template_saved") return { name, pass: false, detail: `audit.type=${audit?.type}` };
  if (audit?.templateKey !== expectedKey) return { name, pass: false, detail: `audit.templateKey=${audit?.templateKey}` };
  if (audit?.version !== 1) return { name, pass: false, detail: `audit.version=${audit?.version}` };
  if (audit?.changeNote !== "Initial Comcast restoration template") return { name, pass: false, detail: `audit.changeNote=${audit?.changeNote}` };

  return { name, pass: true, detail: `templateKey=${expectedKey} v1 created; audit logged` };
}

async function s2_editExistingTemplateBumpsVersion() {
  const name = "2) Edit existing template → v2; createdBy preserved";
  const templateKey = `fiber_splice_verification__comcast-restoration`;
  const before = await readTemplate(templateKey);
  if (before?.version !== 1) return { name, pass: false, detail: `precondition: prior version should be 1 (got ${before?.version})` };
  const originalCreatedBy = before.createdBy;

  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    archetype: "fiber_splice_verification",
    customerLabel: "Comcast Restoration",
    requiredProof: ["Splice enclosure photo", "Fiber labeling photo", "Vault context photo"],   // added one
    optionalProof: ["OTDR trace"],
    acceptanceCriteria: ["Required photos uploaded", "Vault QA signoff"],
    acceptanceChecks: [
      { type: "requires_supervisor_approval", tier: "required", label: "Comcast QA signoff" },
      { type: "requires_field_notes", tier: "required" },
      { type: "requires_at_least_one_gps_proof", tier: "encouraged", label: "GPS recommended" },
    ],
    changeNote: "Added vault context + GPS encouragement",
  });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  if (res.body.version !== 2) return { name, pass: false, detail: `version=${res.body.version}` };
  if (res.body.isCreate) return { name, pass: false, detail: "isCreate should be false on update" };

  const doc = await readTemplate(templateKey);
  if (doc.version !== 2) return { name, pass: false, detail: `doc.version=${doc.version}` };
  if (doc.createdBy !== originalCreatedBy) return { name, pass: false, detail: `createdBy changed: ${originalCreatedBy} -> ${doc.createdBy}` };
  if (doc.requiredProof.length !== 3) return { name, pass: false, detail: `requiredProof.length=${doc.requiredProof.length}` };
  if (doc.acceptanceChecks.length !== 3) return { name, pass: false, detail: `acceptanceChecks.length=${doc.acceptanceChecks.length}` };

  return { name, pass: true, detail: `v1 → v2; createdBy preserved; 3 required-proof items; 3 checks` };
}

async function s3_orgWideTemplate() {
  const name = "3) Org-wide template (no customerLabel) — templateKey = archetype";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    archetype: "storm_restoration_proof",
    // no customerLabel — org-wide
    requiredProof: ["Before photo", "After photo"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [{ type: "requires_incident_closure", tier: "required" }],
  });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  if (res.body.templateKey !== "storm_restoration_proof") return { name, pass: false, detail: `templateKey=${res.body.templateKey}` };

  const doc = await readTemplate("storm_restoration_proof");
  if (doc?.customerSlug !== "") return { name, pass: false, detail: `customerSlug should be empty; got "${doc?.customerSlug}"` };
  if (doc?.customerLabel !== "") return { name, pass: false, detail: `customerLabel should be empty; got "${doc?.customerLabel}"` };
  return { name, pass: true, detail: `org-wide template at doc id "storm_restoration_proof"` };
}

async function s4_invalidArchetypeRejected() {
  const name = "4) Invalid archetype → 400 invalid_archetype";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    archetype: "totally_not_an_archetype",
    customerLabel: "Bogus Customer",
    requiredProof: ["any"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if (res.status !== 400) return { name, pass: false, detail: `expected 400; got ${res.status}` };
  if (res.body?.error !== "invalid_archetype") return { name, pass: false, detail: `error=${res.body?.error}` };
  return { name, pass: true, detail: `400 invalid_archetype as expected` };
}

async function s5_emptyRequiredProofRejected() {
  const name = "5) Empty requiredProof → 400 empty_requiredProof (all-or-nothing)";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    archetype: "custom",
    customerLabel: "No-Proof Customer",
    requiredProof: [],   // empty
    optionalProof: ["something"],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if (res.status !== 400) return { name, pass: false, detail: `expected 400; got ${res.status}` };
  if (res.body?.error !== "empty_requiredProof") return { name, pass: false, detail: `error=${res.body?.error}` };
  return { name, pass: true, detail: `400 empty_requiredProof as expected` };
}

async function s6_malformedCheckTypeDropped() {
  const name = "6) Malformed acceptanceCheck.type silently dropped; valid checks persisted";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    archetype: "custom",
    customerLabel: "Dropper Customer",
    requiredProof: ["any"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [
      { type: "requires_field_notes", tier: "required", label: "Real check" },
      { type: "not_a_real_check_type", tier: "required", label: "Should be dropped" },   // dropped
      { type: "requires_incident_closure", tier: "encouraged" },
    ],
  });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status}` };

  const doc = await readTemplate(`custom__dropper-customer`);
  if (doc.acceptanceChecks.length !== 2) {
    return { name, pass: false, detail: `expected 2 valid checks; got ${doc.acceptanceChecks.length}: ${doc.acceptanceChecks.map(c=>c.type).join(",")}` };
  }
  const types = doc.acceptanceChecks.map((c) => c.type);
  if (types.includes("not_a_real_check_type")) {
    return { name, pass: false, detail: `bad type leaked through: ${types.join(",")}` };
  }
  return { name, pass: true, detail: `bad check dropped; 2 valid checks persisted (${types.join(", ")})` };
}

async function s7_sanitizeLabelsAndCaps() {
  const name = "7) Sanitize: control chars stripped, label capped at 200, description at 500";
  const hugeLabel = "X".repeat(500);
  const hugeDesc = "Y".repeat(1000);
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: ADMIN_UID,
    orgId: ORG_ID,
    archetype: "custom",
    customerLabel: "Caps Customer",
    requiredProof: ["Clean\x00proof\x09entry"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [
      { type: "requires_field_notes", tier: "required", label: hugeLabel, description: hugeDesc },
    ],
  });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `${res.status}` };

  const doc = await readTemplate(`custom__caps-customer`);
  if (/[\x00-\x1F\x7F]/.test(doc.requiredProof[0])) {
    return { name, pass: false, detail: `requiredProof[0] still contains control chars: ${JSON.stringify(doc.requiredProof[0])}` };
  }
  if (doc.acceptanceChecks[0].label.length !== 200) {
    return { name, pass: false, detail: `label.length=${doc.acceptanceChecks[0].label.length}` };
  }
  if (doc.acceptanceChecks[0].description.length !== 500) {
    return { name, pass: false, detail: `description.length=${doc.acceptanceChecks[0].description.length}` };
  }
  return { name, pass: true, detail: `requiredProof sanitized; label capped to 200; description capped to 500` };
}

async function s8_nonAdminDenied() {
  const name = "8) Non-admin (field role) → 403 permission-denied";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: FIELD_UID,   // field role, NOT admin
    orgId: ORG_ID,
    archetype: "custom",
    customerLabel: "Permission Test",
    requiredProof: ["any"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if (res.status !== 403) return { name, pass: false, detail: `expected 403; got ${res.status}` };
  if (res.body?.error !== "permission-denied") return { name, pass: false, detail: `error=${res.body?.error}` };
  return { name, pass: true, detail: `403 permission-denied for field role` };
}

async function s9_listOrgTemplatesV1() {
  const name = "9) listOrgTemplatesV1 returns lightweight summaries, sorted updatedAt-desc, admin-gated";
  // Non-admin should also be denied here
  const denied = await getJson("listOrgTemplatesV1", { orgId: ORG_ID, actorUid: FIELD_UID });
  if (denied.status !== 403) return { name, pass: false, detail: `non-admin should 403; got ${denied.status}` };

  // Admin sees the list
  const ok = await getJson("listOrgTemplatesV1", { orgId: ORG_ID, actorUid: ADMIN_UID });
  if (ok.status !== 200 || !ok.body?.ok) return { name, pass: false, detail: `${ok.status} ${JSON.stringify(ok.body).slice(0,200)}` };
  const templates = ok.body.templates || [];
  if (templates.length < 4) return { name, pass: false, detail: `expected ≥4 templates from previous scenarios; got ${templates.length}` };

  // Each summary should have count fields, NOT full arrays
  const sample = templates[0];
  if (!Number.isFinite(sample.requiredProofCount)) return { name, pass: false, detail: "requiredProofCount missing" };
  if (Object.prototype.hasOwnProperty.call(sample, "requiredProof")) {
    return { name, pass: false, detail: "list should project counts only, not arrays" };
  }
  // updatedAt-desc: confirm first item is at-or-after second
  if (templates.length >= 2) {
    const a = Date.parse(templates[0].updatedAt || templates[0].createdAt || "") || 0;
    const b = Date.parse(templates[1].updatedAt || templates[1].createdAt || "") || 0;
    if (a < b) return { name, pass: false, detail: `not sorted desc: ${templates[0].templateKey}(${templates[0].updatedAt}) < ${templates[1].templateKey}(${templates[1].updatedAt})` };
  }
  return { name, pass: true, detail: `${templates.length} templates returned; admin-gated; counts only; sorted updatedAt-desc` };
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] PROJECT=${PROJECT_ID} FN_BASE=${FN_BASE}`);
  await sleep(500);
  console.log("[smoke] seeding org + members (admin + field)");
  await seedOrgAndMembers();

  const scenarios = [
    s1_createCustomerTemplate,
    s2_editExistingTemplateBumpsVersion,
    s3_orgWideTemplate,
    s4_invalidArchetypeRejected,
    s5_emptyRequiredProofRejected,
    s6_malformedCheckTypeDropped,
    s7_sanitizeLabelsAndCaps,
    s8_nonAdminDenied,
    s9_listOrgTemplatesV1,
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
