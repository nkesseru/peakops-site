#!/usr/bin/env node
// PR 110 — Draft Field Session Start smoke harness.
//
// Verifies the minimal fix in startFieldSessionV1: a freshly-created
// draft incident must be able to start a field session, the incident
// flips to in_progress, addEvidence is then reachable, refresh fires,
// and locked/exported records still reject session start.
//
// Run via: scripts/dev/run_smoke_draft_session_pr110.sh
// Requires: emulators booted; env vars set by launcher.

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT_ID = process.env.PROJECT_ID || "peakops-emu-smoke";
const REGION = process.env.REGION || "us-central1";
const FN_HOST = process.env.FN_HOST || "127.0.0.1:5004";
const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
const FN_BASE = `http://${FN_HOST}/${PROJECT_ID}/${REGION}`;

const ORG_ID = "smoke-org-pr110";
const UID = "smoke-actor";
const TECH_UID = "smoke-tech";
const BUCKET = "smoke-bucket";
const FIXED_STORAGE_PATH = "smoke/photo.jpg";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

async function postJson(name, body) {
  const url = `${FN_BASE}/${name}`;
  const res = await fetch(url, {
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
  await db.doc(`orgs/${ORG_ID}`).set({ name: "PR110 Smoke Org", createdAt: FieldValue.serverTimestamp() });
  await db.doc(`orgs/${ORG_ID}/members/${UID}`).set({ role: "admin", status: "active" });
}

async function seedIncident(incidentId, status) {
  const incidentDoc = {
    incidentId,
    orgId: ORG_ID,
    status,
    requirements: {
      source: "smoke_template",
      requiredProof: [],
      acceptanceChecks: [
        { type: "requires_at_least_one_gps_proof", tier: "required" },
        { type: "requires_incident_closure", tier: "required" },
      ],
    },
    createdAt: FieldValue.serverTimestamp(),
  };
  // Match what createIncidentV1 does: write to both org-scoped and legacy paths.
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).set(incidentDoc);
  await db.doc(`incidents/${incidentId}`).set(incidentDoc);
}

async function readIncidentStatus(incidentId) {
  const snap = await db.doc(`incidents/${incidentId}`).get();
  return snap.data()?.status || null;
}

async function readReadiness(incidentId) {
  const snap = await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).get();
  return snap.data()?.readinessCache || null;
}

async function ensureStorageBlob() {
  const url = `http://${STORAGE_HOST}/v0/b/${BUCKET}/o?name=${encodeURIComponent(FIXED_STORAGE_PATH)}&uploadType=media`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`storage upload failed ${res.status}: ${txt.slice(0, 200)}`);
  }
}

// ── scenarios ──────────────────────────────────────────────────────

async function s1_draftSessionStarts() {
  const name = "1) Draft incident → startFieldSessionV1 succeeds + flips status";
  const incidentId = "smoke-draft-start";
  await seedIncident(incidentId, "draft");
  const preStatus = await readIncidentStatus(incidentId);
  if (preStatus !== "draft") return { name, pass: false, detail: `precondition: pre status=${preStatus} (expected draft)` };

  const res = await postJson("startFieldSessionV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, techUserId: TECH_UID,
  });
  if (res.status !== 200 || !res.body?.ok) {
    return { name, pass: false, detail: `startFieldSession ${res.status} ${JSON.stringify(res.body).slice(0, 200)}` };
  }
  const sessionId = res.body.sessionId;
  if (!sessionId || !sessionId.startsWith("ses_")) {
    return { name, pass: false, detail: `sessionId missing or malformed: ${sessionId}` };
  }
  const postStatus = await readIncidentStatus(incidentId);
  if (postStatus !== "in_progress") {
    return { name, pass: false, detail: `expected status=in_progress after start; got ${postStatus}` };
  }
  // Verify session doc landed.
  const sesSnap = await db.doc(`incidents/${incidentId}/fieldSessions/${sessionId}`).get();
  if (!sesSnap.exists) return { name, pass: false, detail: "session doc not written" };

  return { name, pass: true, detail: `pre=draft post=in_progress sessionId=${sessionId}` };
}

async function s2_addEvidenceReachableAfterStart() {
  const name = "2) After draft start, addEvidenceV1 is reachable + writes evidence";
  const incidentId = "smoke-draft-evidence";
  await seedIncident(incidentId, "draft");
  // Start session
  const startRes = await postJson("startFieldSessionV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, techUserId: TECH_UID,
  });
  if (startRes.status !== 200 || !startRes.body?.ok) {
    return { name, pass: false, detail: `startFieldSession ${startRes.status} ${JSON.stringify(startRes.body).slice(0,200)}` };
  }
  const sessionId = startRes.body.sessionId;
  // Now upload evidence (the path that was blocked before PR 110).
  const evRes = await postJson("addEvidenceV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, sessionId,
    bucket: BUCKET, storagePath: FIXED_STORAGE_PATH,
    originalName: "draft-smoke.jpg", contentType: "image/jpeg",
    gps: { lat: 42.0, lng: -75.0, accuracyM: 5, source: "device" },
    phase: "during",
  });
  if (evRes.status !== 200 || !evRes.body?.ok) {
    return { name, pass: false, detail: `addEvidence ${evRes.status} ${JSON.stringify(evRes.body).slice(0,200)}` };
  }
  const ev = await db.collection(`incidents/${incidentId}/evidence_locker`).get();
  if (ev.size !== 1) return { name, pass: false, detail: `expected 1 evidence doc, got ${ev.size}` };

  return { name, pass: true, detail: `addEvidence ok; evidenceId=${evRes.body.evidenceId}` };
}

async function s3_readinessRefreshAfterDraftFlow() {
  const name = "3) Readiness refresh runs end-to-end on draft flow";
  const incidentId = "smoke-draft-readiness";
  await seedIncident(incidentId, "draft");
  // No initial readinessCache (seeded incident doesn't have one).
  const cache0 = await readReadiness(incidentId);
  // Start session
  const startRes = await postJson("startFieldSessionV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, techUserId: TECH_UID,
  });
  if (startRes.status !== 200 || !startRes.body?.ok) {
    return { name, pass: false, detail: `startFieldSession ${startRes.status}` };
  }
  const sessionId = startRes.body.sessionId;
  // Upload evidence with GPS → expect cache refresh via PR 108 wiring.
  const evRes = await postJson("addEvidenceV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, sessionId,
    bucket: BUCKET, storagePath: FIXED_STORAGE_PATH,
    originalName: "readiness-after-draft.jpg", contentType: "image/jpeg",
    gps: { lat: 43.0, lng: -75.0, accuracyM: 5, source: "device" },
    phase: "during",
  });
  if (evRes.status !== 200 || !evRes.body?.ok) {
    return { name, pass: false, detail: `addEvidence ${evRes.status} ${JSON.stringify(evRes.body).slice(0,200)}` };
  }
  // PR 108 wiring should have written the cache with GPS satisfied.
  const cache1 = await readReadiness(incidentId);
  if (!cache1) return { name, pass: false, detail: "no readinessCache after addEvidence (refresh failed)" };
  const gpsCheck = (cache1.checks || []).find((c) => c.key === "template_check__at_least_one_gps_proof");
  if (!gpsCheck) return { name, pass: false, detail: `gps check missing; keys=${(cache1.checks||[]).map(c=>c.key).join(",")}` };
  if (gpsCheck.satisfied !== true) return { name, pass: false, detail: `gps satisfied=${gpsCheck.satisfied}` };

  return { name, pass: true, detail: `pre-cache=${cache0 ? "present" : "<none>"}; post-cache state=${cache1.state}; gps satisfied=true` };
}

async function s4_closedStillRejects() {
  const name = "4) Closed incident still rejects session start (incident_closed)";
  const incidentId = "smoke-closed";
  await seedIncident(incidentId, "closed");
  const res = await postJson("startFieldSessionV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, techUserId: TECH_UID,
  });
  if (res.status !== 409) {
    return { name, pass: false, detail: `expected 409; got ${res.status} body=${JSON.stringify(res.body).slice(0,200)}` };
  }
  if (res.body?.error !== "incident_closed") {
    return { name, pass: false, detail: `expected error=incident_closed; got ${res.body?.error}` };
  }
  return { name, pass: true, detail: `409 incident_closed (preserved)` };
}

async function s5_exportedStillRejects() {
  const name = "5) Bogus/exported status still rejects (invalid_transition)";
  // Use "exported" as a representative locked-but-not-closed status.
  // Per the allow-list, anything outside {draft, open, active, in_progress}
  // is rejected.
  const incidentId = "smoke-exported";
  await seedIncident(incidentId, "exported");
  const res = await postJson("startFieldSessionV1", {
    actorUid: UID, orgId: ORG_ID, incidentId, techUserId: TECH_UID,
  });
  if (res.status !== 409) {
    return { name, pass: false, detail: `expected 409; got ${res.status} body=${JSON.stringify(res.body).slice(0,200)}` };
  }
  if (res.body?.error !== "invalid_transition") {
    return { name, pass: false, detail: `expected error=invalid_transition; got ${res.body?.error}` };
  }
  // Confirm message references the actual status so debug is easy.
  if (!String(res.body?.detail || "").includes("exported")) {
    return { name, pass: false, detail: `detail should reference "exported"; got "${res.body?.detail}"` };
  }
  return { name, pass: true, detail: `409 invalid_transition detail="${res.body.detail}"` };
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] PROJECT=${PROJECT_ID} FN_BASE=${FN_BASE} STORAGE=${STORAGE_HOST}`);
  await sleep(500);

  console.log("[smoke] seeding org + member");
  await seedOrgAndMember();
  console.log("[smoke] uploading storage probe blob");
  await ensureStorageBlob();

  const scenarios = [s1_draftSessionStarts, s2_addEvidenceReachableAfterStart, s3_readinessRefreshAfterDraftFlow, s4_closedStillRejects, s5_exportedStillRejects];
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
