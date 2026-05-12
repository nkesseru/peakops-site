// PEAKOPS_DEMO_CLOSED_LOOP_V1 (2026-05-12) — Slice Demo Closed-Loop
// Polish 1.0 prerequisite.
//
// Seeds the 6 lifecycle timeline_events that exportIncidentPacketV1
// requires as the truth-mismatch gate. The function rejects exports
// with 409 truth_mismatch unless the timeline_events subcollection
// holds at least:
//   - 1 field_submitted event
//   - 1 incident_closed event
//   - 1 job_approved event per approved job
//
// The seed script (scripts/seedDemoIncident.cjs) wrote incident +
// job + evidence + notes but skipped timeline_events on the
// assumption that the codebase reconstructed them from timestamps.
// It doesn't — exportIncidentPacketV1 reads them out of the
// canonical timeline_events subcollection. This script closes
// that gap so Demo Closed-Loop Polish 1.0 can drive Generate
// Report end-to-end.
//
// What it writes (when --apply is set) for the targeted org:
//   orgs/{org}/incidents/{id}/timeline_events/<auto-id>  ← 6 docs
//
// Event types + timestamps mirror the alpha incident's natural
// lifecycle pattern, derived from the muni / utility incident +
// job timestamps that were already seeded:
//   FIELD_ARRIVED       at incident.inProgressAt
//   EVIDENCE_ADDED      at evidence.storedAt
//   job_completed       at job.completedAt
//   FIELD_SUBMITTED     at incident.submittedAt
//   job_approved        at job.approvedAt
//   incident_closed     at incident.closedAt
//
// Idempotent: refuses to seed if any timeline_events already exist
// for the target incident (so re-running after a successful
// Generate Report — which adds a "generated" event of its own —
// won't duplicate the lifecycle docs).
//
// Usage:
//   node scripts/seedDemoTimelineEvents.cjs --kind=muni
//   node scripts/seedDemoTimelineEvents.cjs --kind=utility --apply

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function getArg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : "";
}

const KIND = String(getArg("kind") || "").trim().toLowerCase();
const APPLY = process.argv.includes("--apply");

if (!["muni", "utility"].includes(KIND)) {
  console.error("Usage: node scripts/seedDemoTimelineEvents.cjs --kind=muni|utility [--apply]");
  process.exit(2);
}

const TARGETS = {
  muni: {
    org: "peakops-internal-muni",
    id: "inc_20260511_205431_773c1b",
  },
  utility: {
    org: "peakops-internal-utility",
    id: "inc_20260511_205446_c6bf95",
  },
};

const target = TARGETS[KIND];

if (target.org === "peakops-internal-alpha" || target.org === "demo-org") {
  console.error(`[seed-tle] FATAL — refusing to seed protected org ${target.org}.`);
  process.exit(2);
}

function loadServiceAccount() {
  const tryPaths = [
    process.env.PEAKOPS_SA_PATH,
    path.resolve(__dirname, "..", "service-account.json"),
  ].filter(Boolean);
  for (const p of tryPaths) {
    if (p && fs.existsSync(p)) {
      const sa = JSON.parse(fs.readFileSync(p, "utf8"));
      if (sa.private_key && sa.private_key.includes("\\n")) {
        sa.private_key = sa.private_key.replace(/\\n/g, "\n");
      }
      return sa;
    }
  }
  return null;
}

(async () => {
  const sa = loadServiceAccount();
  if (!sa) {
    console.error("[seed-tle] no service account found");
    process.exit(1);
  }
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: sa.project_id,
    });
  }
  console.log(`[seed-tle] project=${sa.project_id} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[seed-tle] kind=${KIND} org=${target.org} incident=${target.id}`);

  const db = admin.firestore();
  const orgIncRef = db.doc(`orgs/${target.org}/incidents/${target.id}`);
  const orgIncSnap = await orgIncRef.get();
  if (!orgIncSnap.exists) {
    console.error(`[seed-tle] FAIL — incident not found at orgs/${target.org}/incidents/${target.id}`);
    process.exit(3);
  }
  const inc = orgIncSnap.data() || {};

  // Idempotency: refuse if timeline_events already exist.
  const existingTle = await orgIncRef.collection("timeline_events").get();
  if (!existingTle.empty) {
    console.log(`[seed-tle] timeline_events already populated (${existingTle.size} docs). No-op.`);
    process.exit(0);
  }

  // Resolve the single job + single evidence doc so we can fill
  // refId on the job_* and EVIDENCE_ADDED events.
  const jobsSnap = await db.collection(`incidents/${target.id}/jobs`).get();
  if (jobsSnap.empty || jobsSnap.size !== 1) {
    console.error(`[seed-tle] FAIL — expected exactly 1 job, found ${jobsSnap.size}`);
    process.exit(3);
  }
  const jobDoc = jobsSnap.docs[0];
  const job = jobDoc.data() || {};

  const evSnap = await db.collection(`incidents/${target.id}/evidence_locker`).get();
  if (evSnap.empty || evSnap.size !== 1) {
    console.error(`[seed-tle] FAIL — expected exactly 1 evidence_locker, found ${evSnap.size}`);
    process.exit(3);
  }
  const evDoc = evSnap.docs[0];
  const ev = evDoc.data() || {};

  // Pull timestamps off the existing docs.
  function asTs(v) {
    if (!v) return null;
    if (v.toDate) return admin.firestore.Timestamp.fromDate(v.toDate());
    if (v._seconds) return new admin.firestore.Timestamp(v._seconds, v._nanoseconds || 0);
    if (v instanceof Date) return admin.firestore.Timestamp.fromDate(v);
    return null;
  }
  const tsInProgress = asTs(inc.inProgressAt);
  const tsEvidence   = asTs(ev.storedAt) || asTs(ev.createdAt);
  const tsCompleted  = asTs(job.completedAt);
  const tsSubmitted  = asTs(inc.submittedAt);
  const tsApproved   = asTs(job.approvedAt);
  const tsClosed     = asTs(inc.closedAt);

  if (!tsInProgress || !tsEvidence || !tsCompleted || !tsSubmitted || !tsApproved || !tsClosed) {
    console.error(`[seed-tle] FAIL — missing one or more timestamps:`);
    console.error(`  inProgressAt: ${!!tsInProgress}  evidenceStoredAt: ${!!tsEvidence}`);
    console.error(`  completedAt:  ${!!tsCompleted}   submittedAt:      ${!!tsSubmitted}`);
    console.error(`  approvedAt:   ${!!tsApproved}    closedAt:         ${!!tsClosed}`);
    process.exit(3);
  }

  // Actor strings mirror the alpha incident's pattern:
  //   FIELD_ARRIVED / FIELD_SUBMITTED → user uid (the crew/operator)
  //   EVIDENCE_ADDED                  → "field"
  //   job_completed                   → "field"
  //   job_approved                    → user uid (supervisor)
  //   incident_closed                 → "ui"
  // For the demo orgs the operator + supervisor are the same admin
  // (Nick), so we use his uid as both. A fresher seed could split
  // them — alpha's split into a field-crew uid and a supervisor uid
  // because the alpha lifecycle was driven by two real accounts. The
  // single-uid version still satisfies the export gate.
  const adminUid = String(inc.createdBy?.uid || inc.bootstrappedBy || "qTZahBZ59UTHj0CGNSdjF8ivyhX2");
  const sessionId = String(ev.sessionId || "");
  const jobId = String(jobDoc.id);
  const evidenceId = String(evDoc.id);

  const events = [
    {
      type: "FIELD_ARRIVED",
      occurredAt: tsInProgress,
      actor: adminUid,
      sessionId,
      refId: null,
      meta: null,
    },
    {
      type: "EVIDENCE_ADDED",
      occurredAt: tsEvidence,
      actor: "field",
      sessionId,
      refId: evidenceId,
      meta: null,
    },
    {
      type: "job_completed",
      occurredAt: tsCompleted,
      actor: "field",
      sessionId: null,
      refId: jobId,
      meta: { assignedOrgId: target.org, from: "open", to: "complete" },
    },
    {
      type: "FIELD_SUBMITTED",
      occurredAt: tsSubmitted,
      actor: adminUid,
      sessionId,
      refId: null,
      meta: null,
    },
    {
      type: "job_approved",
      occurredAt: tsApproved,
      actor: adminUid,
      sessionId: null,
      refId: jobId,
      meta: { locked: true },
    },
    {
      type: "incident_closed",
      occurredAt: tsClosed,
      actor: "ui",
      sessionId: null,
      refId: null,
      meta: null,
    },
  ];

  console.log(`\n[seed-tle] PLAN — 6 timeline_events under orgs/${target.org}/incidents/${target.id}/timeline_events`);
  events.forEach((e) => {
    const iso = e.occurredAt.toDate().toISOString();
    console.log(`  ${e.type.padEnd(18)} @ ${iso}   actor=${e.actor}   refId=${e.refId || "-"}`);
  });

  if (!APPLY) {
    console.log("\n[seed-tle] DRY RUN — pass --apply to write.");
    process.exit(0);
  }

  const batch = db.batch();
  for (const e of events) {
    const ref = orgIncRef.collection("timeline_events").doc();
    batch.set(ref, {
      type: e.type,
      occurredAt: e.occurredAt,
      actor: e.actor,
      v: 1,
      orgId: target.org,
      incidentId: target.id,
      sessionId: e.sessionId,
      refId: e.refId,
      meta: e.meta,
      gps: null,
      _pathSource: "orgs",
      _source: "demo-closed-loop-seed",
    });
  }
  await batch.commit();

  const after = await orgIncRef.collection("timeline_events").get();
  console.log(`\n[seed-tle] write OK. timeline_events count: ${after.size}`);
  console.log(`[seed-tle] Now safe to run:`);
  console.log(`  node scripts/generateDemoReport.cjs --kind=${KIND} --apply`);
  process.exit(0);
})().catch((e) => {
  console.error(`[seed-tle] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
