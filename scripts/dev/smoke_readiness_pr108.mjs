#!/usr/bin/env node
// PR 108 — Acceptance Readiness Freshness smoke harness.
//
// Drives the 4 wired mutation callables against the Firebase emulator
// suite and asserts readinessCache state after each call. Burst + a
// refresh-failure-isolation scenario included.
//
// Run via: scripts/dev/run_smoke_readiness_pr108.sh
// Requires: emulators booted; PROJECT_ID/FIRESTORE_EMULATOR_HOST/etc. set
// by the launcher.

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT_ID  = process.env.PROJECT_ID  || "peakops-emu-smoke";
const REGION      = process.env.REGION      || "us-central1";
const FN_HOST     = process.env.FN_HOST     || "127.0.0.1:5004";
const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
const FN_BASE = `http://${FN_HOST}/${PROJECT_ID}/${REGION}`;

const ORG_ID = "smoke-org";
const UID    = "smoke-actor";
const BUCKET = "smoke-bucket";
const SESSION_ID = "smoke-session";
const FIXED_STORAGE_PATH = "smoke/photo.jpg";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// ── helpers ────────────────────────────────────────────────────────
async function postJson(name, body) {
  const url = `${FN_BASE}/${name}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { /* keep text */ }
  return { status: res.status, body: json || text };
}

async function seedOrgAndMember() {
  await db.doc(`orgs/${ORG_ID}`).set({ name: "Smoke Org", createdAt: FieldValue.serverTimestamp() });
  await db.doc(`orgs/${ORG_ID}/members/${UID}`).set({ role: "admin", status: "active" });
}

function defaultAcceptanceChecks() {
  return [
    { type: "requires_at_least_one_gps_proof", tier: "required" },
    { type: "requires_supervisor_approval",   tier: "required" },
    { type: "requires_incident_closure",      tier: "required" },
    { type: "requires_field_notes",           tier: "required" },
  ];
}

async function seedIncident(incidentId, { status = "open", checks = defaultAcceptanceChecks(), withSession = true, withJob = true, jobStatus = "review" } = {}) {
  const requirements = {
    source: "smoke_template",
    requiredProof: [],         // no per-slot required proof for these tests
    acceptanceChecks: checks,
  };
  const incidentDoc = {
    incidentId,
    orgId: ORG_ID,
    status,
    requirements,
    createdAt: FieldValue.serverTimestamp(),
  };
  // Seed both org-scoped and legacy so the helper finds either.
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).set(incidentDoc);
  await db.doc(`incidents/${incidentId}`).set(incidentDoc);

  if (withSession) {
    await db.doc(`incidents/${incidentId}/fieldSessions/${SESSION_ID}`).set({
      orgId: ORG_ID, incidentId, sessionId: SESSION_ID,
      status: "IN_PROGRESS",
      startedAt: FieldValue.serverTimestamp(),
    });
  }
  if (withJob) {
    await db.doc(`incidents/${incidentId}/jobs/smoke-job`).set({
      orgId: ORG_ID, incidentId, jobId: "smoke-job",
      title: "Smoke Job",
      status: jobStatus,
      reviewStatus: jobStatus,
    });
  }
}

async function readReadiness(incidentId) {
  const snap = await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).get();
  const data = snap.data() || {};
  return data.readinessCache || null;
}

function findCheck(cache, key) {
  if (!cache || !Array.isArray(cache.checks)) return null;
  return cache.checks.find((c) => c.key === key) || null;
}

// Upload one dummy blob to storage emulator so addEvidence's emulator
// existence probe succeeds. addEvidenceV1's probe GETs /v0/b/{bucket}/o/{path}.
async function ensureStorageBlob() {
  const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o?name=${encodeURIComponent(FIXED_STORAGE_PATH)}&uploadType=media`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), // minimal JPEG-ish bytes
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`storage upload failed ${res.status}: ${txt.slice(0, 200)}`);
  }
}

// ── scenarios ──────────────────────────────────────────────────────

async function s1_gpsRefresh() {
  const name = "1) GPS proof refresh (addEvidenceV1)";
  const incidentId = "smoke-gps";
  await seedIncident(incidentId);
  const pre = await readReadiness(incidentId);
  const res = await postJson("addEvidenceV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, sessionId: SESSION_ID,
    bucket: BUCKET, storagePath: FIXED_STORAGE_PATH,
    originalName: "smoke.jpg", contentType: "image/jpeg",
    gps: { lat: 40.0, lng: -75.0, accuracyM: 5, source: "device" },
    phase: "during",
  });
  if (res.status !== 200 || !res.body?.ok) {
    return { name, pass: false, detail: `addEvidence ${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  }
  const post = await readReadiness(incidentId);
  const check = findCheck(post, "template_check__at_least_one_gps_proof");
  if (!post) return { name, pass: false, detail: "no readinessCache after addEvidence" };
  if (!check) return { name, pass: false, detail: `gps check missing; cache keys=[${(post.checks||[]).map(c=>c.key).join(",")}]` };
  if (check.satisfied !== true) return { name, pass: false, detail: `gps check satisfied=${check.satisfied}` };
  return { name, pass: true, detail: `gps satisfied=true; pre=${pre?.state||"<none>"} post=${post.state}` };
}

async function s2_approvalRefresh() {
  // Freshness assertion only. PR 108 wires the refresh; whether the
  // resulting cache shows supervisor_approval satisfied is a separate
  // question that depends on writer/evaluator semantics.
  //
  // Pre-existing finding (out of scope for PR 108): approveJobV1 writes
  // status:"approved" but the readiness evaluator only checks
  // reviewStatus/decision, so approveJobV1 alone cannot flip
  // supervisor_approval. approveAndLockJobV1 writes both fields and
  // does flip it. Worth a separate follow-up.
  //
  // What this test verifies for PR 108: after approveJobV1, the
  // readinessCache exists, was recomputed (generatedAt present), and
  // reflects current state (job status field).
  const name = "2) Approval refresh fires + recomputes (approveJobV1)";
  const incidentId = "smoke-approve";
  await seedIncident(incidentId, { jobStatus: "review" });
  const res = await postJson("approveJobV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, jobId: "smoke-job",
  });
  if (res.status !== 200 || !res.body?.ok) {
    return { name, pass: false, detail: `approveJob ${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  }
  const cache = await readReadiness(incidentId);
  if (!cache) return { name, pass: false, detail: "no cache after approveJobV1" };
  if (!cache.generatedAt) return { name, pass: false, detail: "cache.generatedAt missing — refresh didn't recompute" };
  // Verify the job in firestore actually got the approve write so we
  // know the mutation primary write happened (sanity).
  const jobSnap = await db.doc(`incidents/${incidentId}/jobs/smoke-job`).get();
  const jobStatus = jobSnap.data()?.status;
  if (jobStatus !== "approved") {
    return { name, pass: false, detail: `job.status=${jobStatus} (expected "approved")` };
  }
  return { name, pass: true, detail: `cache recomputed (generatedAt=${cache.generatedAt}); job.status=approved; state=${cache.state}` };
}

async function s3_closureRefresh() {
  const name = "3) Closure refresh (closeIncidentV1)";
  const incidentId = "smoke-close";
  // Seed with status=open; use forceClose=true to bypass approved-jobs gate (allowed in emulator).
  await seedIncident(incidentId, { status: "open", jobStatus: "review" });
  const res = await postJson("closeIncidentV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, forceClose: true,
  });
  if (res.status !== 200 || !res.body?.ok) {
    return { name, pass: false, detail: `closeIncident ${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  }
  const cache = await readReadiness(incidentId);
  const universal = findCheck(cache, "incident_closure");
  const template = findCheck(cache, "template_check__incident_closure");
  if (!cache) return { name, pass: false, detail: "no cache" };
  if (universal?.satisfied !== true || template?.satisfied !== true) {
    return { name, pass: false, detail: `universal=${universal?.satisfied} template=${template?.satisfied}` };
  }
  return { name, pass: true, detail: `closure satisfied; state=${cache.state}` };
}

async function s4_notesRefresh() {
  const name = "4) Notes refresh (saveIncidentNotesV1)";
  const incidentId = "smoke-notes";
  await seedIncident(incidentId);
  const res = await postJson("saveIncidentNotesV1", {
    actorUid: UID, orgId: ORG_ID, incidentId,
    incidentNotes: "All work complete; site secured.",
    siteNotes: "Site neat.",
  });
  if (res.status !== 200 || !res.body?.ok) {
    return { name, pass: false, detail: `saveNotes ${res.status} ${JSON.stringify(res.body).slice(0,200)}` };
  }
  const cache = await readReadiness(incidentId);
  const check = findCheck(cache, "template_check__field_notes");
  if (!cache) return { name, pass: false, detail: "no cache" };
  if (check?.satisfied !== true) {
    return { name, pass: false, detail: `field_notes satisfied=${check?.satisfied} (detail=${check?.detail||"n/a"})` };
  }
  return { name, pass: true, detail: `field_notes satisfied; state=${cache.state}` };
}

async function s5_burstConvergence() {
  const name = "5) Burst evidence convergence";
  const incidentId = "smoke-burst";
  await seedIncident(incidentId);
  // Fire 5 parallel addEvidence calls (same blob path; the doc IDs are
  // generated server-side so each lands as a distinct evidence_locker doc).
  const calls = Array.from({ length: 5 }, (_, i) =>
    postJson("addEvidenceV1", {
      actorUid: UID, orgId: ORG_ID, incidentId, sessionId: SESSION_ID,
      bucket: BUCKET, storagePath: FIXED_STORAGE_PATH,
      originalName: `burst-${i}.jpg`, contentType: "image/jpeg",
      gps: { lat: 41.0 + i * 0.01, lng: -75.0, accuracyM: 5, source: "device" },
      phase: "during",
    })
  );
  const results = await Promise.all(calls);
  const failures = results.filter((r) => r.status !== 200 || !r.body?.ok);
  if (failures.length) {
    return { name, pass: false, detail: `${failures.length}/5 calls failed; first=${JSON.stringify(failures[0]).slice(0,200)}` };
  }
  // Cache should reflect ≥1 evidence on the GPS check. Final state may
  // reflect any of the 5 writes (last-writer-wins). All 5 successful
  // writes mean evidence count = 5; the GPS template check has
  // satisfied threshold ≥1, so any of the cached recomputes seeing
  // ≥1 evidence is correct.
  const ev = await db.collection(`incidents/${incidentId}/evidence_locker`).get();
  const evCount = ev.docs.length;
  const cache = await readReadiness(incidentId);
  const check = findCheck(cache, "template_check__at_least_one_gps_proof");
  if (evCount !== 5) {
    return { name, pass: false, detail: `expected 5 evidence docs; got ${evCount}` };
  }
  if (!cache || check?.satisfied !== true) {
    return { name, pass: false, detail: `cache.gps satisfied=${check?.satisfied} (evCount=${evCount})` };
  }
  return { name, pass: true, detail: `5/5 calls ok; evidence=${evCount}; cache gps satisfied=true; state=${cache.state}` };
}

async function s6_refreshFailureIsolation() {
  const name = "6) Mutation succeeds when refresh fails";
  // saveIncidentNotesV1 doesn't require the incident doc to exist
  // (it writes to incidents/{id}/notes/main directly). If we use an
  // incidentId that is NOT seeded at any path, refreshReadinessCache
  // will log "incident_not_found" and return null — but the mutation
  // response should still be ok:true.
  const incidentId = "smoke-no-incident-doc";
  // Confirm nothing exists at the canonical or legacy paths.
  const canonical = await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).get();
  const legacy    = await db.doc(`incidents/${incidentId}`).get();
  if (canonical.exists || legacy.exists) {
    return { name, pass: false, detail: "precondition: incident doc should not exist" };
  }
  const res = await postJson("saveIncidentNotesV1", {
    actorUid: UID, orgId: ORG_ID, incidentId,
    incidentNotes: "Notes for an incident that doesn't have a parent doc.",
  });
  if (res.status !== 200 || !res.body?.ok) {
    return { name, pass: false, detail: `saveNotes returned ${res.status} ${JSON.stringify(res.body).slice(0,200)} — mutation should still succeed` };
  }
  // Confirm refresh did NOT create a cache (because the helper bailed
  // out before write).
  const post = await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).get();
  const cache = post.data()?.readinessCache;
  if (cache) {
    return { name, pass: false, detail: "refresh should have failed; cache should not exist" };
  }
  // Confirm notes WAS written (mutation primary write).
  const notes = await db.doc(`incidents/${incidentId}/notes/main`).get();
  if (!notes.exists) {
    return { name, pass: false, detail: "notes/main should have been written" };
  }
  return { name, pass: true, detail: "saveNotes returned ok:true; cache absent; notes written" };
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] PROJECT=${PROJECT_ID} FN_BASE=${FN_BASE} STORAGE=${STORAGE_HOST}`);

  // Wait a short moment for functions emulator to fully register routes
  // (some runs hit the URL while the firebase-functions discovery is
  // still finishing).
  await sleep(500);

  console.log("[smoke] seeding org + member");
  await seedOrgAndMember();
  console.log("[smoke] uploading storage probe blob");
  await ensureStorageBlob();

  const scenarios = [s1_gpsRefresh, s2_approvalRefresh, s3_closureRefresh, s4_notesRefresh, s5_burstConvergence, s6_refreshFailureIsolation];
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
