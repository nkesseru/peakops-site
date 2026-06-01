#!/usr/bin/env node
// PR 120a — Template Provenance backend smoke harness.
//
// Verifies the HTTP round-trip:
//   1. saveOrgTemplateV1 accepts + sanitizes requiredProofDescriptions
//   2. createIncidentV1 snapshot writes customerLabel +
//      requiredProofDescriptions onto incident.requirements
//   3. _readiness.js emits description on required_proof check rows
//   4. PR 118 backwards-compat: acceptance-check description still flows
//   5. Snapshot freezing (PR 104/118 contract) still preserved
//
// Run via: scripts/dev/run_smoke_template_provenance_pr120a.sh

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT_ID = process.env.PROJECT_ID || "peakops-emu-smoke";
const REGION = process.env.REGION || "us-central1";
const FN_HOST = process.env.FN_HOST || "127.0.0.1:5004";
const FN_BASE = `http://${FN_HOST}/${PROJECT_ID}/${REGION}`;

const ORG_ID = "smoke-org-pr120a";
const UID = "smoke-admin";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

async function seedOrgAndMember() {
  await db.doc(`orgs/${ORG_ID}`).set({ name: "PR120a Smoke Org", createdAt: FieldValue.serverTimestamp() });
  await db.doc(`orgs/${ORG_ID}/members/${UID}`).set({ role: "admin", status: "active" });
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

async function readIncidentSnapshot(incidentId) {
  const canon = await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).get();
  return canon.exists ? canon.data() : null;
}
async function readReadinessCheck(incidentId, key) {
  const snap = await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).get();
  const cache = snap.data()?.readinessCache;
  if (!cache || !Array.isArray(cache.checks)) return null;
  return cache.checks.find((c) => c.key === key) || null;
}
async function readTemplate(templateKey) {
  const snap = await db.doc(`orgs/${ORG_ID}/templates/${templateKey}`).get();
  return snap.exists ? snap.data() : null;
}

// ── scenarios ──────────────────────────────────────────────────────

async function s1_templateAcceptsRequiredProofDescriptions() {
  const name = "1) saveOrgTemplateV1 accepts + persists requiredProofDescriptions";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: UID,
    orgId: ORG_ID,
    archetype: "fiber_splice_verification",
    customerLabel: "Cascade Broadband Infrastructure",
    requiredProof: ["GPS capture", "Completion photos", "Splice loss reading"],
    requiredProofDescriptions: [
      "Customer requires proof of site presence.",
      "",                                                  // empty for this slot
      "Required by Cascade-2024 contract §4.2",
    ],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) {
    return { name, pass: false, detail: `save ${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  }
  const tpl = await readTemplate(res.body.templateKey);
  if (!Array.isArray(tpl?.requiredProofDescriptions)) {
    return { name, pass: false, detail: "template missing requiredProofDescriptions array" };
  }
  if (tpl.requiredProofDescriptions.length !== 3) {
    return { name, pass: false, detail: `length=${tpl.requiredProofDescriptions.length} expected 3` };
  }
  if (tpl.requiredProofDescriptions[0] !== "Customer requires proof of site presence.") {
    return { name, pass: false, detail: `[0]=${tpl.requiredProofDescriptions[0]}` };
  }
  if (tpl.requiredProofDescriptions[1] !== "") {
    return { name, pass: false, detail: `[1] should be empty; got=${tpl.requiredProofDescriptions[1]}` };
  }
  return { name, pass: true, detail: `parallel array (length 3) persisted on template doc` };
}

async function s2_descriptionsTruncatedAndStrippedOnSave() {
  const name = "2) save sanitize: control chars stripped, ≤500 caps enforced";
  const huge = "Y".repeat(700);
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: UID,
    orgId: ORG_ID,
    archetype: "custom",
    customerLabel: "Sanitize Customer",
    requiredProof: ["proof a", "proof b"],
    requiredProofDescriptions: [
      "Clean\x00reason\x09text\x1F",     // control chars stripped
      huge,                                // 700 → 500
    ],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) return { name, pass: false, detail: `save ${res.status}` };
  const tpl = await readTemplate(res.body.templateKey);
  if (/[\x00-\x1F\x7F]/.test(tpl.requiredProofDescriptions[0])) {
    return { name, pass: false, detail: `[0] still contains control chars: ${JSON.stringify(tpl.requiredProofDescriptions[0])}` };
  }
  if (tpl.requiredProofDescriptions[1].length !== 500) {
    return { name, pass: false, detail: `[1].length=${tpl.requiredProofDescriptions[1].length}` };
  }
  return { name, pass: true, detail: `control chars stripped; long entry capped to 500` };
}

async function s3_descriptionsParallelArrayInvariant() {
  const name = "3) parallel array invariant: descriptions padded/truncated to requiredProof.length";
  // Send a descriptions array LONGER than requiredProof — server should truncate
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: UID,
    orgId: ORG_ID,
    archetype: "custom",
    customerLabel: "Invariant Customer",
    requiredProof: ["only one item"],
    requiredProofDescriptions: ["reason A", "reason B (should be dropped)", "reason C (should be dropped)"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) return { name, pass: false, detail: `save ${res.status}` };
  const tpl = await readTemplate(res.body.templateKey);
  if (tpl.requiredProofDescriptions.length !== 1) {
    return { name, pass: false, detail: `length=${tpl.requiredProofDescriptions.length} expected 1` };
  }
  if (tpl.requiredProofDescriptions[0] !== "reason A") {
    return { name, pass: false, detail: `[0]=${tpl.requiredProofDescriptions[0]}` };
  }

  // Send descriptions array SHORTER than requiredProof — server should pad
  const res2 = await postJson("saveOrgTemplateV1", {
    actorUid: UID,
    orgId: ORG_ID,
    archetype: "custom",
    customerLabel: "Invariant Customer Two",
    requiredProof: ["item a", "item b", "item c"],
    requiredProofDescriptions: ["only first"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if ((res2.status !== 200 && res2.status !== 201) || !res2.body?.ok) return { name, pass: false, detail: `save ${res2.status}` };
  const tpl2 = await readTemplate(res2.body.templateKey);
  if (tpl2.requiredProofDescriptions.length !== 3) {
    return { name, pass: false, detail: `length=${tpl2.requiredProofDescriptions.length} expected 3 (padded)` };
  }
  if (tpl2.requiredProofDescriptions[0] !== "only first" || tpl2.requiredProofDescriptions[1] !== "" || tpl2.requiredProofDescriptions[2] !== "") {
    return { name, pass: false, detail: `padded array shape: ${JSON.stringify(tpl2.requiredProofDescriptions)}` };
  }
  return { name, pass: true, detail: `truncate and pad both enforce parallel-array invariant` };
}

async function s4_allEmptyDescriptionsOmittedFromTemplateDoc() {
  const name = "4) All-empty descriptions → field omitted from template doc";
  const res = await postJson("saveOrgTemplateV1", {
    actorUid: UID,
    orgId: ORG_ID,
    archetype: "custom",
    customerLabel: "All Empty Customer",
    requiredProof: ["a", "b"],
    requiredProofDescriptions: ["", "   "],   // both empty after trim
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) return { name, pass: false, detail: `save ${res.status}` };
  const tpl = await readTemplate(res.body.templateKey);
  if ("requiredProofDescriptions" in tpl) {
    return { name, pass: false, detail: "all-empty array should be omitted to keep doc lean" };
  }
  return { name, pass: true, detail: "field omitted when no entry carries text" };
}

async function s5_provenanceOnIncidentSnapshot() {
  const name = "5) createIncident snapshots customerLabel + requiredProofDescriptions + templateVersion";
  // Re-create a clean template with full rationales for this scenario
  const tplRes = await postJson("saveOrgTemplateV1", {
    actorUid: UID,
    orgId: ORG_ID,
    archetype: "fiber_splice_verification",
    customerLabel: "Cascade Broadband Infrastructure",
    requiredProof: ["GPS capture"],
    requiredProofDescriptions: ["Customer requires proof of site presence."],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  });
  if ((tplRes.status !== 200 && tplRes.status !== 201) || !tplRes.body?.ok) {
    return { name, pass: false, detail: `template save ${tplRes.status}` };
  }
  const expectedVersion = tplRes.body.version;

  const res = await postJson("createIncidentV1", {
    actorUid: UID,
    orgId: ORG_ID,
    customer: "Cascade Broadband Infrastructure",
    archetype: "fiber_splice_verification",
    title: "Provenance smoke incident",
    location: "Site Z",
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) {
    return { name, pass: false, detail: `createIncident ${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  }
  const incidentId = res.body.incidentId;
  const snap = await readIncidentSnapshot(incidentId);
  const reqs = snap?.requirements;
  if (!reqs) return { name, pass: false, detail: "incident.requirements missing" };

  // Provenance fields
  if (reqs.customerLabel !== "Cascade Broadband Infrastructure") {
    return { name, pass: false, detail: `customerLabel=${reqs.customerLabel}` };
  }
  if (reqs.templateVersion !== expectedVersion) {
    return { name, pass: false, detail: `templateVersion=${reqs.templateVersion} expected ${expectedVersion}` };
  }
  if (!reqs.templateKey || !reqs.templateKey.includes("__cascade-broadband-infrastructure")) {
    return { name, pass: false, detail: `templateKey=${reqs.templateKey}` };
  }
  if (!Array.isArray(reqs.requiredProofDescriptions) || reqs.requiredProofDescriptions[0] !== "Customer requires proof of site presence.") {
    return { name, pass: false, detail: `requiredProofDescriptions=${JSON.stringify(reqs.requiredProofDescriptions)}` };
  }

  // readinessCache should also carry the description on the required_proof row
  const row = await readReadinessCheck(incidentId, "required_proof__gps-capture");
  if (!row) return { name, pass: false, detail: "readinessCache row for gps-capture missing" };
  if (row.description !== "Customer requires proof of site presence.") {
    return { name, pass: false, detail: `cache row description=${row.description}` };
  }
  return { name, pass: true, detail: `customerLabel + requiredProofDescriptions on snapshot; readinessCache row carries description` };
}

async function s6_archetypeFallbackHasNoProvenance() {
  const name = "6) Archetype fallback (no customer template) → no customerLabel/requiredProofDescriptions";
  // Use a customer name with NO seeded template — falls through to archetype catalog
  const res = await postJson("createIncidentV1", {
    actorUid: UID,
    orgId: ORG_ID,
    customer: "Unknown Customer Without Template",
    archetype: "fiber_splice_verification",
    title: "Archetype fallback smoke",
    location: "Site W",
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) {
    return { name, pass: false, detail: `createIncident ${res.status}` };
  }
  const incidentId = res.body.incidentId;
  const snap = await readIncidentSnapshot(incidentId);
  const reqs = snap?.requirements || {};
  // Could either fall through to org-wide template or all the way to archetype.
  // The s3 + s4 customers above created templates — but only customer-specific
  // ones. The org-wide fiber_splice_verification slot is empty. So this should
  // fall through to archetype.
  if (reqs.source !== "archetype") {
    return { name, pass: false, detail: `expected source=archetype; got source=${reqs.source}` };
  }
  if (reqs.customerLabel) {
    return { name, pass: false, detail: `customerLabel should be absent on archetype fallback; got "${reqs.customerLabel}"` };
  }
  if (reqs.requiredProofDescriptions !== undefined) {
    return { name, pass: false, detail: `requiredProofDescriptions should be absent on archetype fallback` };
  }
  return { name, pass: true, detail: `archetype fallback: no provenance fields; source=archetype` };
}

async function s7_pr118AcceptanceCheckDescriptionRegression() {
  const name = "7) PR 118 acceptance-check description still flows (regression)";
  const tplRes = await postJson("saveOrgTemplateV1", {
    actorUid: UID,
    orgId: ORG_ID,
    archetype: "custom",
    customerLabel: "PR118 Regression Customer",
    requiredProof: ["something"],
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [{
      type: "requires_supervisor_approval",
      tier: "required",
      label: "Customer QA signoff",
      description: "Per customer 2024 contract §3.2",
    }],
  });
  if ((tplRes.status !== 200 && tplRes.status !== 201) || !tplRes.body?.ok) return { name, pass: false, detail: `template save ${tplRes.status}` };

  const res = await postJson("createIncidentV1", {
    actorUid: UID,
    orgId: ORG_ID,
    customer: "PR118 Regression Customer",
    archetype: "custom",
    title: "PR 118 regression",
    location: "Site V",
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) return { name, pass: false, detail: `createIncident ${res.status}` };

  const row = await readReadinessCheck(res.body.incidentId, "template_check__supervisor_approval");
  if (!row) return { name, pass: false, detail: "row missing" };
  if (row.label !== "Customer QA signoff" || row.description !== "Per customer 2024 contract §3.2") {
    return { name, pass: false, detail: `label="${row.label}" description="${row.description}"` };
  }
  return { name, pass: true, detail: `acceptance-check label + description still flow through` };
}

async function s8_snapshotImmutability() {
  const name = "8) Template edits do NOT bleed into in-flight incidents (audit grade)";
  // Use a fresh customer to avoid version drift from earlier scenarios
  const customer = "Immutability Customer";
  await postJson("saveOrgTemplateV1", {
    actorUid: UID, orgId: ORG_ID,
    archetype: "custom", customerLabel: customer,
    requiredProof: ["GPS capture"],
    requiredProofDescriptions: ["Original rationale"],
    optionalProof: [], acceptanceCriteria: [], acceptanceChecks: [],
  });
  const incRes = await postJson("createIncidentV1", {
    actorUid: UID, orgId: ORG_ID, customer, archetype: "custom",
    title: "Immutability incident", location: "Site U",
  });
  if ((incRes.status !== 200 && incRes.status !== 201) || !incRes.body?.ok) return { name, pass: false, detail: `createIncident ${incRes.status}` };
  const incidentId = incRes.body.incidentId;

  // Edit the template
  await postJson("saveOrgTemplateV1", {
    actorUid: UID, orgId: ORG_ID,
    archetype: "custom", customerLabel: customer,
    requiredProof: ["GPS capture"],
    requiredProofDescriptions: ["EDITED rationale — should NOT apply retroactively"],
    optionalProof: [], acceptanceCriteria: [], acceptanceChecks: [],
  });

  // Force readiness recompute on the existing incident
  const recompute = await fetch(`${FN_BASE}/getAcceptanceReadinessV1?orgId=${ORG_ID}&incidentId=${incidentId}&actorUid=${UID}`);
  const recBody = await recompute.json().catch(() => ({}));
  if (!recBody?.ok) return { name, pass: false, detail: `recompute ${recompute.status}` };

  const row = await readReadinessCheck(incidentId, "required_proof__gps-capture");
  if (row?.description !== "Original rationale") {
    return { name, pass: false, detail: `expected "Original rationale"; got "${row?.description}" — template edit leaked into existing incident` };
  }
  return { name, pass: true, detail: `snapshot frozen at creation; edit did not retroactively apply` };
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] PROJECT=${PROJECT_ID} FN_BASE=${FN_BASE}`);
  await sleep(500);
  console.log("[smoke] seeding org + admin member");
  await seedOrgAndMember();

  const scenarios = [
    s1_templateAcceptsRequiredProofDescriptions,
    s2_descriptionsTruncatedAndStrippedOnSave,
    s3_descriptionsParallelArrayInvariant,
    s4_allEmptyDescriptionsOmittedFromTemplateDoc,
    s5_provenanceOnIncidentSnapshot,
    s6_archetypeFallbackHasNoProvenance,
    s7_pr118AcceptanceCheckDescriptionRegression,
    s8_snapshotImmutability,
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
