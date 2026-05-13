// PEAKOPS_AUDIT_TRAIL_REALISM_V1 (2026-05-12) — Slice Audit Trail
// Realism 1.0.
//
// Re-cadences the muni + utility demo audit trails to industry-
// believable timings, so the Summary's Audit Trail tells a real
// operational story rather than the mechanical 5m → 25m → 30m → 5m
// → 25m → 5m cadence the original seed used.
//
// Industry narratives (rationale baked into the timings):
//
//   MUNICIPALITY — Catch basin inspection
//     A routine inspection on a maintenance route. Crew drives to
//     the site (~10m), inspects the basin and takes photos (~12m),
//     completes and submits (~few minutes). Supervisor reviews
//     the morning batch in the afternoon (~4 hours later), then
//     closes the record minutes after approval.
//        T+10m   FIELD_ARRIVED
//        T+22m   EVIDENCE_ADDED
//        T+27m   job_completed
//        T+30m   FIELD_SUBMITTED
//        T+4h15m job_approved
//        T+4h18m incident_closed
//
//   UTILITY — Outage response (matches the notes' "06:42 reported,
//     restored at 09:18" framing). Urgent dispatch + drive, on-site
//     repair span, restoration documented as the line comes back
//     up, ops-center supervisor approves quickly, close follows.
//        T+12m   FIELD_ARRIVED
//        T+88m   EVIDENCE_ADDED      (photo of repaired span)
//        T+150m  job_completed
//        T+156m  FIELD_SUBMITTED     (matches notes: restored at 09:18)
//        T+170m  job_approved
//        T+175m  incident_closed
//
// What the script writes (when --apply is set) for the targeted org:
//   1. orgs/{org}/incidents/{id}/timeline_events/* → occurredAt
//   2. orgs/{org}/incidents/{id}.inProgressAt
//   3. orgs/{org}/incidents/{id}.submittedAt
//   4. orgs/{org}/incidents/{id}.closedAt
//   5. orgs/{org}/incidents/{id}.updatedAt    (now)
//   6. incidents/{id}.inProgressAt/submittedAt/closedAt/updatedAt
//      (the top-level mirror)
//   7. incidents/{id}/jobs/{jobId}.completedAt
//   8. incidents/{id}/jobs/{jobId}.approvedAt
//   9. incidents/{id}/jobs/{jobId}.updatedAt  (now)
//   10. incidents/{id}/evidence_locker/{evId}.storedAt
//   11. incidents/{id}/evidence_locker/{evId}.createdAt
//   12. incidents/{id}/evidence_locker/{evId}.file.conversionUpdatedAt
//
// What this script deliberately does NOT do:
//   - Does not touch peakops-internal-alpha (real history,
//     already realistic — explicit hard-refusal guard).
//   - Does not touch peakops-internal-contractor (no closed-loop
//     demo exists yet — explicit hard-refusal until --kind=
//     contractor is wired alongside a contractor seed).
//   - Does not touch demo-org.
//   - Does not modify actors, event types, notes, tasks, photos,
//     packetMeta, branding, claims, rules, or any other field.
//   - Does not modify the original incident.createdAt — that's
//     the anchor every other timestamp is computed against.
//
// After this script runs, the in-app Summary will show the new
// cadence immediately. The packetMeta-cached ZIP downloads with
// the OLD audit trail until you run:
//   node scripts/generateDemoReport.cjs --kind=muni    --apply
//   node scripts/generateDemoReport.cjs --kind=utility --apply
// which bumps the report revision and bakes the new audit trail
// into a fresh signed ZIP.

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

if (!["muni", "utility", "contractor"].includes(KIND)) {
  console.error("Usage: node scripts/polishDemoTimelines.cjs --kind=muni|utility|contractor [--apply]");
  process.exit(2);
}

// Industry-believable offsets in minutes from incident.createdAt.
// PEAKOPS_AUDIT_TRAIL_REALISM_V1_0_1 (2026-05-12) — utility offsets
// re-tuned to align with the Field Notes narrative: outage reported
// 06:42 AM, restoration 09:18 AM, supervisor approval 11:45 AM,
// close 12:00 PM. Pair with --anchorAt=2026-05-11T13:42:00Z (06:42
// PDT in UTC) so the absolute times read correctly in the Los_Angeles
// org-timezone display.
const CADENCES = {
  muni: {
    org: "peakops-internal-muni",
    id: "inc_20260511_205431_773c1b",
    offsets: {
      FIELD_ARRIVED:   10,
      EVIDENCE_ADDED:  22,
      job_completed:   27,
      FIELD_SUBMITTED: 30,
      job_approved:    4 * 60 + 15,
      incident_closed: 4 * 60 + 18,
    },
  },
  utility: {
    org: "peakops-internal-utility",
    id: "inc_20260511_205446_c6bf95",
    offsets: {
      // Aligned to the Field Notes narrative (06:42 → 12:00).
      FIELD_ARRIVED:   16,    // 06:58 — arrived at switch-house
      EVIDENCE_ADDED:  90,    // 08:12 — photo of restored span
      job_completed:   156,   // 09:18 — restoration verified
      FIELD_SUBMITTED: 168,   // 09:30 — submitted to supervisor
      job_approved:    303,   // 11:45 — supervisor approval
      incident_closed: 318,   // 12:00 — job closed
    },
  },
  // PEAKOPS_CONTRACTOR_DEMO_SEED_V1 (2026-05-12) — contractor cadence
  // (project-closeout walkthrough). When paired with
  // --anchorAt=2026-05-12T15:00:00Z the times read as a believable
  // 08:00 → 12:30 PDT half-day. id=null resolved at runtime via
  // source=demo-artifact-seed lookup.
  contractor: {
    org: "peakops-internal-contractor",
    id: null,
    offsets: {
      FIELD_ARRIVED:   20,    // 08:20 — crew on site
      EVIDENCE_ADDED:  95,    // 09:35 — walkthrough photos
      job_completed:   125,   // 10:05 — closeout verified
      FIELD_SUBMITTED: 135,   // 10:15 — submitted to supervisor
      job_approved:    255,   // 12:15 — client/lead approval
      incident_closed: 270,   // 12:30 — handoff packaged
    },
  },
};

const target = CADENCES[KIND];

// PEAKOPS_AUDIT_TRAIL_REALISM_V1_0_1 (2026-05-12) — optional override
// for incident.createdAt. When passed, the script re-anchors the
// incident's creation timestamp to this ISO string before applying
// the cadence offsets. Used to align utility's audit trail with the
// "outage reported at 06:42 AM" framing in the Field Notes. Without
// this flag, the existing createdAt is preserved (default behavior).
const ANCHOR_AT_ISO = String(getArg("anchorAt") || "").trim();
const ANCHOR_OVERRIDE = ANCHOR_AT_ISO ? new Date(ANCHOR_AT_ISO) : null;
if (ANCHOR_AT_ISO && (!ANCHOR_OVERRIDE || isNaN(ANCHOR_OVERRIDE.getTime()))) {
  console.error(`[polish-timeline] FATAL — --anchorAt=${ANCHOR_AT_ISO} is not a valid ISO timestamp`);
  process.exit(2);
}

// PEAKOPS_CONTRACTOR_DEMO_SEED_V1 (2026-05-12) — peakops-internal-
// contractor is no longer protected here (the contractor closed-loop
// demo now exists and benefits from re-cadence + anchorAt support).
// Alpha + demo-org remain protected.
const PROTECTED_ORGS = new Set([
  "peakops-internal-alpha",
  "demo-org",
]);
if (PROTECTED_ORGS.has(target.org)) {
  console.error(`[polish-timeline] FATAL — refusing to write to protected org ${target.org}.`);
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

function asDate(v) {
  if (!v) return null;
  if (v.toDate) return v.toDate();
  if (v._seconds) return new Date(v._seconds * 1000);
  if (v instanceof Date) return v;
  return null;
}

(async () => {
  const sa = loadServiceAccount();
  if (!sa) {
    console.error("[polish-timeline] no service account found");
    process.exit(1);
  }
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
  }
  console.log(`[polish-timeline] project=${sa.project_id} mode=${APPLY ? "APPLY" : "dry-run"}`);

  const db = admin.firestore();

  // PEAKOPS_CONTRACTOR_DEMO_SEED_V1 (2026-05-12) — resolve id at
  // runtime when null (contractor case).
  if (!target.id) {
    const qs = await db
      .collection(`orgs/${target.org}/incidents`)
      .where("source", "==", "demo-artifact-seed")
      .limit(1)
      .get();
    if (qs.empty) {
      console.error(`[polish-timeline] FAIL — no demo-artifact-seed incident found in orgs/${target.org}/incidents.`);
      process.exit(3);
    }
    target.id = qs.docs[0].id;
  }
  console.log(`[polish-timeline] kind=${KIND} org=${target.org} incident=${target.id}`);

  const orgIncRef = db.doc(`orgs/${target.org}/incidents/${target.id}`);
  const topIncRef = db.doc(`incidents/${target.id}`);

  const orgIncSnap = await orgIncRef.get();
  if (!orgIncSnap.exists) {
    console.error(`[polish-timeline] FAIL — incident not found at orgs/${target.org}/incidents/${target.id}`);
    process.exit(3);
  }
  const inc = orgIncSnap.data() || {};
  const existingCreatedAt = asDate(inc.createdAt);
  if (!existingCreatedAt) {
    console.error(`[polish-timeline] FAIL — incident.createdAt missing or unreadable`);
    process.exit(3);
  }
  // PEAKOPS_AUDIT_TRAIL_REALISM_V1_0_1 — re-anchor when --anchorAt
  // is provided. Falls through to the existing createdAt otherwise.
  const createdAt = ANCHOR_OVERRIDE || existingCreatedAt;
  if (ANCHOR_OVERRIDE) {
    console.log(`[polish-timeline] anchor RE-WRITTEN from ${existingCreatedAt.toISOString()} → ${createdAt.toISOString()}`);
  } else {
    console.log(`[polish-timeline] anchor createdAt: ${createdAt.toISOString()}`);
  }

  // Resolve the single job + single evidence doc.
  const jobsSnap = await db.collection(`incidents/${target.id}/jobs`).get();
  const evSnap = await db.collection(`incidents/${target.id}/evidence_locker`).get();
  if (jobsSnap.size !== 1 || evSnap.size !== 1) {
    console.error(`[polish-timeline] FAIL — expected 1 job + 1 evidence, got ${jobsSnap.size} + ${evSnap.size}`);
    process.exit(3);
  }
  const jobRef = jobsSnap.docs[0].ref;
  const jobId = jobsSnap.docs[0].id;
  const evRef = evSnap.docs[0].ref;
  const evidenceId = evSnap.docs[0].id;

  // Resolve the 6 timeline_event docs by type.
  const tleSnap = await orgIncRef.collection("timeline_events").get();
  const byType = {};
  tleSnap.forEach((d) => { byType[String(d.data().type || "")] = d.ref; });
  const expectedTypes = ["FIELD_ARRIVED", "EVIDENCE_ADDED", "job_completed", "FIELD_SUBMITTED", "job_approved", "incident_closed"];
  for (const t of expectedTypes) {
    if (!byType[t]) {
      console.error(`[polish-timeline] FAIL — missing timeline_event type=${t}`);
      process.exit(3);
    }
  }

  function offsetTs(mins) {
    return admin.firestore.Timestamp.fromDate(new Date(createdAt.getTime() + mins * 60_000));
  }

  // Compute the target Timestamp for each anchor.
  const tsFieldArrived   = offsetTs(target.offsets.FIELD_ARRIVED);
  const tsEvidenceAdded  = offsetTs(target.offsets.EVIDENCE_ADDED);
  const tsJobCompleted   = offsetTs(target.offsets.job_completed);
  const tsFieldSubmitted = offsetTs(target.offsets.FIELD_SUBMITTED);
  const tsJobApproved    = offsetTs(target.offsets.job_approved);
  const tsIncidentClosed = offsetTs(target.offsets.incident_closed);

  console.log(`\n[polish-timeline] PLAN`);
  console.log(`  FIELD_ARRIVED    ${asDate(tsFieldArrived).toISOString()}    (+${target.offsets.FIELD_ARRIVED}m)`);
  console.log(`  EVIDENCE_ADDED   ${asDate(tsEvidenceAdded).toISOString()}    (+${target.offsets.EVIDENCE_ADDED}m)`);
  console.log(`  job_completed    ${asDate(tsJobCompleted).toISOString()}    (+${target.offsets.job_completed}m)`);
  console.log(`  FIELD_SUBMITTED  ${asDate(tsFieldSubmitted).toISOString()}    (+${target.offsets.FIELD_SUBMITTED}m)`);
  console.log(`  job_approved     ${asDate(tsJobApproved).toISOString()}    (+${target.offsets.job_approved}m)`);
  console.log(`  incident_closed  ${asDate(tsIncidentClosed).toISOString()}    (+${target.offsets.incident_closed}m)`);
  console.log(`\n  +incident.inProgressAt = FIELD_ARRIVED time`);
  console.log(`  +incident.submittedAt  = FIELD_SUBMITTED time`);
  console.log(`  +incident.closedAt     = incident_closed time`);
  console.log(`  +job.completedAt       = job_completed time`);
  console.log(`  +job.approvedAt        = job_approved time`);
  console.log(`  +evidence.storedAt/createdAt = EVIDENCE_ADDED time`);
  console.log(`  +incident/job updatedAt = now`);

  if (!APPLY) {
    console.log(`\n[polish-timeline] DRY RUN — pass --apply to write.`);
    process.exit(0);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();

  // 1) Timeline event occurredAt updates.
  batch.update(byType.FIELD_ARRIVED,   { occurredAt: tsFieldArrived });
  batch.update(byType.EVIDENCE_ADDED,  { occurredAt: tsEvidenceAdded });
  batch.update(byType.job_completed,   { occurredAt: tsJobCompleted });
  batch.update(byType.FIELD_SUBMITTED, { occurredAt: tsFieldSubmitted });
  batch.update(byType.job_approved,    { occurredAt: tsJobApproved });
  batch.update(byType.incident_closed, { occurredAt: tsIncidentClosed });

  // 2) Incident timestamps (both paths — dual-write convention).
  // PEAKOPS_AUDIT_TRAIL_REALISM_V1_0_1 — when --anchorAt is set,
  // re-write createdAt too so the audit trail anchors visually to
  // the same moment as the field notes describe.
  const incPatch = {
    inProgressAt: tsFieldArrived,
    submittedAt:  tsFieldSubmitted,
    closedAt:     tsIncidentClosed,
    updatedAt:    now,
  };
  if (ANCHOR_OVERRIDE) {
    incPatch.createdAt = admin.firestore.Timestamp.fromDate(createdAt);
  }
  batch.set(orgIncRef, incPatch, { merge: true });
  batch.set(topIncRef, incPatch, { merge: true });

  // 3) Job timestamps.
  // PEAKOPS_AUDIT_TRAIL_REALISM_V1_0_1 — when --anchorAt is set, the
  // job.createdAt would otherwise predate the incident.createdAt
  // (weird data state). Re-anchor it to the same new incident
  // createdAt for coherence.
  const jobPatch = {
    completedAt: tsJobCompleted,
    approvedAt:  tsJobApproved,
    updatedAt:   now,
  };
  if (ANCHOR_OVERRIDE) {
    jobPatch.createdAt = admin.firestore.Timestamp.fromDate(createdAt);
  }
  batch.set(jobRef, jobPatch, { merge: true });

  // 4) Evidence timestamps + file.conversionUpdatedAt.
  batch.update(evRef, {
    storedAt: tsEvidenceAdded,
    createdAt: tsEvidenceAdded,
    "file.conversionUpdatedAt": tsEvidenceAdded,
  });

  await batch.commit();

  console.log(`\n[polish-timeline] write OK.`);
  console.log(`[polish-timeline] In-app Audit Trail now shows the new cadence.`);
  console.log(`[polish-timeline] Run this to bake the new audit trail into the signed ZIP:`);
  console.log(`  node scripts/generateDemoReport.cjs --kind=${KIND} --apply`);
  process.exit(0);
})().catch((e) => {
  console.error(`[polish-timeline] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
