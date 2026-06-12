#!/usr/bin/env node
// PR 118 — Customer Check Labels smoke harness.
//
// Verifies the full HTTP round-trip:
//   1. Customer-scoped Firestore template carries acceptanceChecks with
//      custom label + description
//   2. createIncidentV1 snapshot sanitize trims + caps + persists
//   3. _readiness.js emits the customer's label/description in the cache
//   4. Stale snapshot semantics: subsequent template edits don't bleed
//      into already-created incidents (audit grade — PR 104 spec)
//
// Run via: scripts/dev/run_smoke_customer_check_labels_pr118.sh
// Requires: emulators booted; env vars set by launcher.

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT_ID = process.env.PROJECT_ID || "peakops-emu-smoke";
const REGION = process.env.REGION || "us-central1";
const FN_HOST = process.env.FN_HOST || "127.0.0.1:5004";
const FN_BASE = `http://${FN_HOST}/${PROJECT_ID}/${REGION}`;

const ORG_ID = "smoke-org-pr118";
const UID = "smoke-actor";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

async function seedOrgAndMember() {
  await db.doc(`orgs/${ORG_ID}`).set({ name: "PR118 Smoke Org", createdAt: FieldValue.serverTimestamp() });
  await db.doc(`orgs/${ORG_ID}/members/${UID}`).set({ role: "admin", status: "active" });
}

// Seed a customer-scoped Firestore template carrying labeled checks.
// Path matches createIncidentV1's customer-template lookup
// (orgs/{orgId}/templates/{archetype}__{toCustomerSlug(customer)}).
// Customer slug derivation (from _customerSlug.js): lower → spaces→hyphens
// → strip non-alphanum-hyphen → collapse runs → trim hyphens.
function customerSlug(customer) {
  return String(customer || "").trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
async function seedCustomerTemplate(customerName, archetype, acceptanceChecks) {
  const key = `${archetype}__${customerSlug(customerName)}`;
  const path = `orgs/${ORG_ID}/templates/${key}`;
  await db.doc(path).set({
    archetype,
    requiredProof: ["Sample required proof"],
    optionalProof: [],
    acceptanceCriteria: ["Customer prose criterion (legacy)"],
    acceptanceChecks,
  });
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

// ── scenarios ──────────────────────────────────────────────────────

async function s1_customerLabelFlowsThrough() {
  const name = "1) Customer label flows from template → snapshot → readinessCache";
  const customerKey = "comcast-restoration";
  const archetype = "storm_restoration_proof";
  await seedCustomerTemplate(customerKey, archetype, [
    {
      type: "requires_field_notes",
      tier: "required",
      label: "Comcast restoration safety notes attached",
      description: "Per Comcast-Restoration acceptance contract 2024-Q3",
    },
  ]);

  const res = await postJson("createIncidentV1", {
    actorUid: UID,
    orgId: ORG_ID,
    customer: customerKey,
    customerKey,
    archetype,
    title: "Smoke Customer Label Flow",
    location: "Site A",
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) {
    return { name, pass: false, detail: `createIncident ${res.status} ${JSON.stringify(res.body).slice(0, 200)}` };
  }
  const incidentId = res.body.incidentId;

  // Snapshot persisted correctly?
  const snap = await readIncidentSnapshot(incidentId);
  const checks = snap?.requirements?.acceptanceChecks || [];
  const snapChk = checks.find((c) => c.type === "requires_field_notes");
  if (!snapChk) return { name, pass: false, detail: "snapshot missing acceptanceChecks[requires_field_notes]" };
  if (snapChk.label !== "Comcast restoration safety notes attached") {
    return { name, pass: false, detail: `snapshot label="${snapChk.label}"` };
  }
  if (snapChk.description !== "Per Comcast-Restoration acceptance contract 2024-Q3") {
    return { name, pass: false, detail: `snapshot description="${snapChk.description}"` };
  }

  // readinessCache was written at create time (PR 106). Verify the
  // emitted check row carries the customer's label + description.
  const row = await readReadinessCheck(incidentId, "template_check__field_notes");
  if (!row) return { name, pass: false, detail: "readinessCache row missing" };
  if (row.label !== "Comcast restoration safety notes attached") {
    return { name, pass: false, detail: `cache label="${row.label}"` };
  }
  if (row.description !== "Per Comcast-Restoration acceptance contract 2024-Q3") {
    return { name, pass: false, detail: `cache description="${row.description}"` };
  }
  return { name, pass: true, detail: `snapshot + cache both carry customer label + description` };
}

async function s2_emptyLabelFallsBackToDefault() {
  const name = "2) Empty/whitespace label → evaluator default used";
  const customerKey = "att-fiber";
  const archetype = "fiber_splice_verification";
  await seedCustomerTemplate(customerKey, archetype, [
    { type: "requires_supervisor_approval", tier: "required", label: "   " }, // whitespace
  ]);

  const res = await postJson("createIncidentV1", {
    actorUid: UID,
    orgId: ORG_ID,
    customer: customerKey,
    customerKey,
    archetype,
    title: "Empty Label Fallback",
    location: "Site B",
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) return { name, pass: false, detail: `createIncident ${res.status}` };
  const incidentId = res.body.incidentId;

  // Sanitize step should have stripped the whitespace-only label.
  // Snapshot should NOT carry a label field; cache row should show
  // the evaluator's hardcoded default.
  const snap = await readIncidentSnapshot(incidentId);
  const snapChk = (snap?.requirements?.acceptanceChecks || []).find((c) => c.type === "requires_supervisor_approval");
  if (snapChk && "label" in snapChk) {
    return { name, pass: false, detail: `whitespace label leaked into snapshot: "${snapChk.label}"` };
  }
  const row = await readReadinessCheck(incidentId, "template_check__supervisor_approval");
  if (!row) return { name, pass: false, detail: "readinessCache row missing" };
  if (row.label !== "Supervisor approval") {
    return { name, pass: false, detail: `expected default "Supervisor approval"; got "${row.label}"` };
  }
  return { name, pass: true, detail: `default label used: "${row.label}"` };
}

async function s3_sanitizeCapsLongLabel() {
  const name = "3) Label > 200 chars truncated; description > 500 chars truncated";
  const customerKey = "verbose-customer";
  const archetype = "fiber_splice_verification";
  const hugeLabel = "X".repeat(500);   // 500 chars, expect capped to 200
  const hugeDesc = "Y".repeat(1000);   // 1000 chars, expect capped to 500
  await seedCustomerTemplate(customerKey, archetype, [
    { type: "requires_field_notes", tier: "required", label: hugeLabel, description: hugeDesc },
  ]);

  const res = await postJson("createIncidentV1", {
    actorUid: UID,
    orgId: ORG_ID,
    customer: customerKey,
    customerKey,
    archetype,
    title: "Verbose Caps",
    location: "Site C",
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) return { name, pass: false, detail: `createIncident ${res.status}` };
  const incidentId = res.body.incidentId;

  const snap = await readIncidentSnapshot(incidentId);
  const snapChk = (snap?.requirements?.acceptanceChecks || []).find((c) => c.type === "requires_field_notes");
  if (!snapChk) return { name, pass: false, detail: "snapshot missing check" };
  if (snapChk.label.length !== 200) {
    return { name, pass: false, detail: `label.length=${snapChk.label.length} (expected 200)` };
  }
  if (snapChk.description.length !== 500) {
    return { name, pass: false, detail: `description.length=${snapChk.description.length} (expected 500)` };
  }
  return { name, pass: true, detail: `label capped to 200; description capped to 500` };
}

async function s4_controlCharsStripped() {
  const name = "4) Control characters stripped from label + description";
  const customerKey = "ctrl-customer";
  const archetype = "fiber_splice_verification";
  // \x00 \x09 \x1F \x7F should all be stripped; spaces preserved
  await seedCustomerTemplate(customerKey, archetype, [
    {
      type: "requires_field_notes",
      tier: "required",
      label: "Clean\x00 label\x09with\x1Fcontrol\x7Fchars",
      description: "Multi\nline\rdesc with control chars\x00",
    },
  ]);

  const res = await postJson("createIncidentV1", {
    actorUid: UID,
    orgId: ORG_ID,
    customer: customerKey,
    customerKey,
    archetype,
    title: "Control Char Strip",
    location: "Site D",
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) return { name, pass: false, detail: `createIncident ${res.status}` };
  const incidentId = res.body.incidentId;

  const snap = await readIncidentSnapshot(incidentId);
  const snapChk = (snap?.requirements?.acceptanceChecks || []).find((c) => c.type === "requires_field_notes");
  if (!snapChk) return { name, pass: false, detail: "snapshot missing check" };
  if (/[\x00-\x1F\x7F]/.test(snapChk.label || "")) {
    return { name, pass: false, detail: `label contains control chars: ${JSON.stringify(snapChk.label)}` };
  }
  if (/[\x00-\x1F\x7F]/.test(snapChk.description || "")) {
    return { name, pass: false, detail: `description contains control chars: ${JSON.stringify(snapChk.description)}` };
  }
  return { name, pass: true, detail: `label="${snapChk.label}" description="${snapChk.description}"` };
}

async function s5_legacyChecksStillWork() {
  const name = "5) Legacy template without label/description still works (no regression)";
  const customerKey = "legacy-customer";
  const archetype = "fiber_splice_verification";
  await seedCustomerTemplate(customerKey, archetype, [
    { type: "requires_incident_closure", tier: "required" }, // no label, no description
  ]);

  const res = await postJson("createIncidentV1", {
    actorUid: UID,
    orgId: ORG_ID,
    customer: customerKey,
    customerKey,
    archetype,
    title: "Legacy Template",
    location: "Site E",
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) return { name, pass: false, detail: `createIncident ${res.status}` };
  const incidentId = res.body.incidentId;

  const snap = await readIncidentSnapshot(incidentId);
  const snapChk = (snap?.requirements?.acceptanceChecks || []).find((c) => c.type === "requires_incident_closure");
  if (!snapChk) return { name, pass: false, detail: "snapshot missing check" };
  if ("label" in snapChk || "description" in snapChk) {
    return { name, pass: false, detail: `legacy check carries phantom label/description: ${JSON.stringify(snapChk)}` };
  }
  const row = await readReadinessCheck(incidentId, "template_check__incident_closure");
  if (!row || row.label !== "Incident closure") {
    return { name, pass: false, detail: `expected default "Incident closure"; got "${row?.label}"` };
  }
  return { name, pass: true, detail: `default label preserved on legacy template` };
}

// Audit-grade: template edits AFTER incident creation don't bleed
// into in-flight incidents. PR 104 contract.
async function s6_snapshotImmutability() {
  const name = "6) Template edits do not bleed into in-flight incidents (audit grade)";
  const customerKey = "snapshot-immutable";
  const archetype = "fiber_splice_verification";
  await seedCustomerTemplate(customerKey, archetype, [
    { type: "requires_field_notes", tier: "required", label: "Original label" },
  ]);

  const res = await postJson("createIncidentV1", {
    actorUid: UID,
    orgId: ORG_ID,
    customer: customerKey,
    customerKey,
    archetype,
    title: "Pre-edit incident",
    location: "Site F",
  });
  if ((res.status !== 200 && res.status !== 201) || !res.body?.ok) return { name, pass: false, detail: `createIncident ${res.status}` };
  const incidentId = res.body.incidentId;

  // Now edit the template — change the label
  await seedCustomerTemplate(customerKey, archetype, [
    { type: "requires_field_notes", tier: "required", label: "Edited label (should NOT apply retroactively)" },
  ]);

  // Force a readiness recompute by hitting getAcceptanceReadinessV1
  const recompute = await fetch(`${FN_BASE}/getAcceptanceReadinessV1?orgId=${ORG_ID}&incidentId=${incidentId}&actorUid=${UID}`);
  const recomputeBody = await recompute.json().catch(() => ({}));
  if (!recomputeBody?.ok) return { name, pass: false, detail: `getAcceptanceReadiness ${recompute.status}` };

  // The in-flight incident should still see "Original label" because
  // the snapshot froze it at creation. The edited template applies
  // only to future incidents.
  const row = await readReadinessCheck(incidentId, "template_check__field_notes");
  if (row?.label !== "Original label") {
    return { name, pass: false, detail: `expected "Original label"; got "${row?.label}" — snapshot leaked template edit` };
  }
  return { name, pass: true, detail: `snapshot frozen at creation; edit did not retroactively apply` };
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] PROJECT=${PROJECT_ID} FN_BASE=${FN_BASE}`);
  await sleep(500);
  console.log("[smoke] seeding org + member");
  await seedOrgAndMember();

  const scenarios = [
    s1_customerLabelFlowsThrough,
    s2_emptyLabelFallsBackToDefault,
    s3_sanitizeCapsLongLabel,
    s4_controlCharsStripped,
    s5_legacyChecksStillWork,
    s6_snapshotImmutability,
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
