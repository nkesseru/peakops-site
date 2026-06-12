#!/usr/bin/env node
// PR 115 — Supervisor Approval Signal smoke harness.
//
// Verifies that approveJobV1 (which writes status:"approved" only)
// satisfies the readiness supervisor_approval check after PR 115
// aligned the evaluator with exportIncidentPacketV1.isApprovedJob.
//
// Run via: scripts/dev/run_smoke_supervisor_approval_pr115.sh
// Requires: emulators booted; env vars set by launcher.

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT_ID = process.env.PROJECT_ID || "peakops-emu-smoke";
const REGION = process.env.REGION || "us-central1";
const FN_HOST = process.env.FN_HOST || "127.0.0.1:5004";
const FN_BASE = `http://${FN_HOST}/${PROJECT_ID}/${REGION}`;

const ORG_ID = "smoke-org-pr115";
const UID = "smoke-actor";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

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

async function seedOrgAndMember() {
  await db.doc(`orgs/${ORG_ID}`).set({ name: "PR115 Smoke Org", createdAt: FieldValue.serverTimestamp() });
  await db.doc(`orgs/${ORG_ID}/members/${UID}`).set({ role: "admin", status: "active" });
}

// Seed an incident with the supervisor-approval template check + one
// job in review status (the state expected by approveJobV1).
async function seedIncidentWithReviewJob(incidentId, jobFields = { status: "review", reviewStatus: "review" }) {
  const incidentDoc = {
    incidentId,
    orgId: ORG_ID,
    status: "open",
    requirements: {
      source: "smoke_template",
      requiredProof: [],
      acceptanceChecks: [
        { type: "requires_supervisor_approval", tier: "required" },
      ],
    },
    createdAt: FieldValue.serverTimestamp(),
  };
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).set(incidentDoc);
  await db.doc(`incidents/${incidentId}`).set(incidentDoc);
  await db.doc(`incidents/${incidentId}/jobs/smoke-job`).set({
    orgId: ORG_ID, incidentId, jobId: "smoke-job", title: "Smoke Job",
    ...jobFields,
  });
}

async function readReadiness(incidentId) {
  const snap = await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).get();
  return snap.data()?.readinessCache || null;
}

function findCheck(cache, key) {
  if (!cache || !Array.isArray(cache.checks)) return null;
  return cache.checks.find((c) => c.key === key) || null;
}

// ── scenarios ──────────────────────────────────────────────────────

// THE PRIMARY ASSERTION: approveJobV1 (status:"approved" only) flips
// supervisor_approval after the refresh wired in PR 108. This was
// explicitly NOT working before PR 115 — documented as a known gap.
async function s1_approveJobV1FlipsUniversal() {
  const name = "1) approveJobV1 flips universal supervisor_approval";
  const incidentId = "smoke-approve-univ";
  await seedIncidentWithReviewJob(incidentId);

  const res = await postJson("approveJobV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, jobId: "smoke-job",
  });
  if (res.status !== 200 || !res.body?.ok) {
    return { name, pass: false, detail: `approveJobV1 ${res.status} ${JSON.stringify(res.body).slice(0, 200)}` };
  }
  const cache = await readReadiness(incidentId);
  const universal = findCheck(cache, "supervisor_approval");
  if (!cache) return { name, pass: false, detail: "no cache after approveJobV1" };
  if (universal?.satisfied !== true) {
    return { name, pass: false, detail: `universal supervisor_approval satisfied=${universal?.satisfied} detail="${universal?.detail}"` };
  }
  // Confirm the writer actually only wrote `status` (not reviewStatus)
  const jobSnap = await db.doc(`incidents/${incidentId}/jobs/smoke-job`).get();
  const jd = jobSnap.data() || {};
  if (jd.status !== "approved") return { name, pass: false, detail: `job.status=${jd.status}` };
  if (jd.reviewStatus === "approved") return { name, pass: false, detail: "precondition: approveJobV1 should NOT write reviewStatus" };

  return { name, pass: true, detail: `job.status=approved (reviewStatus untouched); universal.detail="${universal.detail}"` };
}

// Template check on the same flow — flips for the same reason.
async function s2_approveJobV1FlipsTemplate() {
  const name = "2) approveJobV1 flips template requires_supervisor_approval";
  const incidentId = "smoke-approve-tpl";
  await seedIncidentWithReviewJob(incidentId);

  const res = await postJson("approveJobV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, jobId: "smoke-job",
  });
  if (res.status !== 200 || !res.body?.ok) {
    return { name, pass: false, detail: `approveJobV1 ${res.status}` };
  }
  const cache = await readReadiness(incidentId);
  const template = findCheck(cache, "template_check__supervisor_approval");
  if (template?.satisfied !== true) {
    return { name, pass: false, detail: `template satisfied=${template?.satisfied} detail="${template?.detail}"` };
  }
  return { name, pass: true, detail: `template.detail="${template.detail}"` };
}

// reviewStatus-only approval (pre-PR-115 path) STILL flips — no
// regression for jobs approved via approveAndLockJobV1.
async function s3_reviewStatusOnlyStillSatisfies() {
  const name = "3) reviewStatus-only approval still satisfies (no regression)";
  const incidentId = "smoke-rs-only";
  // Seed an already-approved job via direct write (no callable needed)
  await seedIncidentWithReviewJob(incidentId, { reviewStatus: "approved" });

  // Force refresh: call getAcceptanceReadinessV1 (which recomputes + writes cache)
  // — easiest way to trigger the readiness compute without mutating data.
  const res = await fetch(`${FN_BASE}/getAcceptanceReadinessV1?orgId=${ORG_ID}&incidentId=${incidentId}&actorUid=${UID}`);
  const out = await res.json().catch(() => ({}));
  if (!out?.ok) return { name, pass: false, detail: `getAcceptanceReadinessV1 ${res.status} ${JSON.stringify(out).slice(0, 200)}` };

  const cache = await readReadiness(incidentId);
  const u = findCheck(cache, "supervisor_approval");
  const t = findCheck(cache, "template_check__supervisor_approval");
  if (u?.satisfied !== true || t?.satisfied !== true) {
    return { name, pass: false, detail: `univ=${u?.satisfied} template=${t?.satisfied}` };
  }
  return { name, pass: true, detail: `both satisfied via reviewStatus alone` };
}

// decision-only (legacy) STILL satisfies.
async function s4_decisionOnlyStillSatisfies() {
  const name = "4) decision-only (legacy) still satisfies";
  const incidentId = "smoke-dec-only";
  await seedIncidentWithReviewJob(incidentId, { decision: "approved" });

  const res = await fetch(`${FN_BASE}/getAcceptanceReadinessV1?orgId=${ORG_ID}&incidentId=${incidentId}&actorUid=${UID}`);
  const out = await res.json().catch(() => ({}));
  if (!out?.ok) return { name, pass: false, detail: `getAcceptanceReadinessV1 ${res.status}` };

  const cache = await readReadiness(incidentId);
  const u = findCheck(cache, "supervisor_approval");
  if (u?.satisfied !== true) {
    return { name, pass: false, detail: `univ satisfied=${u?.satisfied} detail="${u?.detail}"` };
  }
  return { name, pass: true, detail: `legacy decision="approved" satisfies` };
}

// Non-approved jobs STILL don't satisfy.
async function s5_reviewStatusReviewDoesNotSatisfy() {
  const name = "5) job in status=review does NOT satisfy";
  const incidentId = "smoke-not-approved";
  await seedIncidentWithReviewJob(incidentId);

  const res = await fetch(`${FN_BASE}/getAcceptanceReadinessV1?orgId=${ORG_ID}&incidentId=${incidentId}&actorUid=${UID}`);
  const out = await res.json().catch(() => ({}));
  if (!out?.ok) return { name, pass: false, detail: `getAcceptanceReadinessV1 ${res.status}` };

  const cache = await readReadiness(incidentId);
  const u = findCheck(cache, "supervisor_approval");
  if (u?.satisfied !== false) {
    return { name, pass: false, detail: `expected satisfied=false; got ${u?.satisfied}` };
  }
  return { name, pass: true, detail: `correctly rejects status=review` };
}

// Multi-job: one approved, two not — counter says "1 of 3".
async function s6_multiJobCounter() {
  const name = "6) multi-job counter: 1 of 3 approved";
  const incidentId = "smoke-multi-job";
  await seedIncidentWithReviewJob(incidentId);
  // Add 2 more jobs not yet approved
  await db.doc(`incidents/${incidentId}/jobs/job-2`).set({
    orgId: ORG_ID, incidentId, jobId: "job-2", title: "Job 2", status: "review", reviewStatus: "review",
  });
  await db.doc(`incidents/${incidentId}/jobs/job-3`).set({
    orgId: ORG_ID, incidentId, jobId: "job-3", title: "Job 3", status: "open", reviewStatus: "open",
  });

  // Approve only smoke-job via the callable
  const res = await postJson("approveJobV1", { actorUid: UID, orgId: ORG_ID, incidentId, jobId: "smoke-job" });
  if (res.status !== 200 || !res.body?.ok) return { name, pass: false, detail: `approveJobV1 ${res.status}` };

  const cache = await readReadiness(incidentId);
  const u = findCheck(cache, "supervisor_approval");
  if (u?.satisfied !== true) return { name, pass: false, detail: `satisfied=${u?.satisfied}` };
  if (!/1 of 3/.test(u?.detail || "")) {
    return { name, pass: false, detail: `expected "1 of 3" in detail; got "${u?.detail}"` };
  }
  return { name, pass: true, detail: u.detail };
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] PROJECT=${PROJECT_ID} FN_BASE=${FN_BASE}`);
  await sleep(500);
  console.log("[smoke] seeding org + member");
  await seedOrgAndMember();

  const scenarios = [
    s1_approveJobV1FlipsUniversal,
    s2_approveJobV1FlipsTemplate,
    s3_reviewStatusOnlyStillSatisfies,
    s4_decisionOnlyStillSatisfies,
    s5_reviewStatusReviewDoesNotSatisfy,
    s6_multiJobCounter,
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
