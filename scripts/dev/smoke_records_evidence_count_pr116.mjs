#!/usr/bin/env node
// PR 116 — Records Live Evidence Count smoke harness.
//
// Verifies that listIncidentsV1 returns a live evidence_locker count
// per incident, regardless of whether packetMeta exists or what it
// claims. Live count is now the single source of truth — Records,
// Summary, and IncidentClient all see the same number.
//
// Run via: scripts/dev/run_smoke_records_evidence_count_pr116.sh
// Requires: emulators booted; env vars set by launcher.

import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT_ID = process.env.PROJECT_ID || "peakops-emu-smoke";
const REGION = process.env.REGION || "us-central1";
const FN_HOST = process.env.FN_HOST || "127.0.0.1:5004";
const FN_BASE = `http://${FN_HOST}/${PROJECT_ID}/${REGION}`;

const ORG_ID = "smoke-org-pr116";
const UID = "smoke-actor";

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

async function seedOrgAndMember() {
  await db.doc(`orgs/${ORG_ID}`).set({ name: "PR116 Smoke Org", createdAt: FieldValue.serverTimestamp() });
  await db.doc(`orgs/${ORG_ID}/members/${UID}`).set({ role: "admin", status: "active" });
}

// Seed an incident at both canonical + legacy paths (matches createIncidentV1).
// `packetMeta` is optional — included only for the sealed-disagreement case.
async function seedIncident(incidentId, opts = {}) {
  const { packetMeta = null, status = "open" } = opts;
  const incidentDoc = {
    incidentId,
    orgId: ORG_ID,
    status,
    title: `Smoke ${incidentId}`,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (packetMeta) incidentDoc.packetMeta = packetMeta;
  await db.doc(`orgs/${ORG_ID}/incidents/${incidentId}`).set(incidentDoc);
  await db.doc(`incidents/${incidentId}`).set(incidentDoc);
}

async function addEvidenceDocs(incidentId, count) {
  for (let i = 0; i < count; i++) {
    await db.doc(`incidents/${incidentId}/evidence_locker/ev-${i}`).set({
      orgId: ORG_ID, incidentId, evidenceId: `ev-${i}`,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
}

async function listIncidents() {
  const url = `${FN_BASE}/listIncidentsV1?orgId=${encodeURIComponent(ORG_ID)}&actorUid=${encodeURIComponent(UID)}&limit=50`;
  const res = await fetch(url, { method: "GET" });
  const out = await res.json().catch(() => ({}));
  return { status: res.status, body: out };
}

function findRow(body, incidentId) {
  const arr = Array.isArray(body?.docs) ? body.docs : Array.isArray(body?.incidents) ? body.incidents : [];
  return arr.find((r) => r.id === incidentId || r.incidentId === incidentId) || null;
}

// ── scenarios ──────────────────────────────────────────────────────

async function s1_zero() {
  const name = "1) Incident with 0 evidence → evidenceCount=0";
  const id = "smoke-ev-0";
  await seedIncident(id);
  // no evidence_locker docs
  const r = await listIncidents();
  if (r.status !== 200 || !r.body?.ok) return { name, pass: false, detail: `list ${r.status}` };
  const row = findRow(r.body, id);
  if (!row) return { name, pass: false, detail: "row missing from response" };
  if (row.evidenceCount !== 0) return { name, pass: false, detail: `evidenceCount=${row.evidenceCount}, expected 0` };
  return { name, pass: true, detail: `evidenceCount=0 as expected` };
}

async function s2_three() {
  const name = "2) Incident with 3 evidence docs → evidenceCount=3";
  const id = "smoke-ev-3";
  await seedIncident(id);
  await addEvidenceDocs(id, 3);
  const r = await listIncidents();
  if (r.status !== 200 || !r.body?.ok) return { name, pass: false, detail: `list ${r.status}` };
  const row = findRow(r.body, id);
  if (!row) return { name, pass: false, detail: "row missing" };
  if (row.evidenceCount !== 3) return { name, pass: false, detail: `evidenceCount=${row.evidenceCount}, expected 3` };
  return { name, pass: true, detail: `evidenceCount=3 (live aggregation)` };
}

async function s3_five() {
  const name = "3) Incident with 5 evidence docs → evidenceCount=5 (mirrors sPW4JR2Cs38lSzggrMh3)";
  const id = "smoke-ev-5";
  await seedIncident(id);
  await addEvidenceDocs(id, 5);
  const r = await listIncidents();
  if (r.status !== 200 || !r.body?.ok) return { name, pass: false, detail: `list ${r.status}` };
  const row = findRow(r.body, id);
  if (!row) return { name, pass: false, detail: "row missing" };
  if (row.evidenceCount !== 5) return { name, pass: false, detail: `evidenceCount=${row.evidenceCount}, expected 5` };
  return { name, pass: true, detail: `evidenceCount=5 (matches Summary's live count for sPW4JR2Cs38lSzggrMh3 scenario)` };
}

// THE CRITICAL ASSERTION: when packetMeta.evidenceCount disagrees with
// live, live MUST win. This is the "single source of truth" guarantee.
async function s4_sealedDisagreement() {
  const name = "4) Sealed-with-packetMeta disagreement → live count wins";
  const id = "smoke-ev-sealed";
  await seedIncident(id, {
    status: "closed",
    packetMeta: {
      evidenceCount: 99,      // intentionally wrong — was the old projected value
      jobCount: 2,            // task counts still come from packetMeta
      approvedJobCount: 2,
      completedJobCount: 2,
      status: "ready",
      downloadUrl: "https://example.com/packet.zip",
    },
  });
  await addEvidenceDocs(id, 4); // live count is 4
  const r = await listIncidents();
  if (r.status !== 200 || !r.body?.ok) return { name, pass: false, detail: `list ${r.status}` };
  const row = findRow(r.body, id);
  if (!row) return { name, pass: false, detail: "row missing" };
  if (row.evidenceCount !== 4) {
    return { name, pass: false, detail: `evidenceCount=${row.evidenceCount}; expected 4 (live), NOT 99 (packetMeta)` };
  }
  // Confirm task-state counts STILL come from packetMeta (we only removed evidenceCount)
  if (row.taskCount !== 2 || row.approvedTaskCount !== 2 || row.completedTaskCount !== 2) {
    return { name, pass: false, detail: `task counts changed: t=${row.taskCount} a=${row.approvedTaskCount} c=${row.completedTaskCount}` };
  }
  if (!row.packetReady || !row.reportReady) {
    return { name, pass: false, detail: `packetReady/reportReady lost: pr=${row.packetReady} rr=${row.reportReady}` };
  }
  return { name, pass: true, detail: `evidenceCount=4 (live wins over packetMeta.evidenceCount=99); task counts + packetReady preserved` };
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[smoke] PROJECT=${PROJECT_ID} FN_BASE=${FN_BASE}`);
  await sleep(500);
  console.log("[smoke] seeding org + member");
  await seedOrgAndMember();

  const scenarios = [s1_zero, s2_three, s3_five, s4_sealedDisagreement];
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
