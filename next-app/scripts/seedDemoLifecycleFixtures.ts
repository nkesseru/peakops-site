// PEAKOPS_DEMO_LIFECYCLE_FIXTURES_SEED_V1 (2026-05-06)
//
// Phase 1 Slice 12.1: seeds three canonical demo-org incidents that
// cover the lifecycle states browser QA walks through:
//
//   inc_20260429_064006_ming4g — Field Job approved/ready-to-close
//   inc_20260429_071222_n3ss11 — Supervisor Review closed
//   inc_20260429_080946_qcetdv — Summary awaiting-supervisor-approval
//
// What this script writes:
//   - Top-level incidents/{id} doc (the canonical path lifecycle
//     callables read from)
//   - Per-org orgs/demo-org/incidents/{id} mirror (the path
//     getIncidentV1 also fall-back-reads from)
//   - One job per incident at incidents/{id}/jobs/{jobId} with the
//     state appropriate to the lifecycle phase
//   - A minimal timeline trail at incidents/{id}/timeline_events
//
// What it deliberately does NOT write:
//   - Real Storage objects. Photos are out of scope per the spec —
//     real bytes through Cloud Storage are too heavy for this slice.
//     The Field/Review/Summary pages render gracefully when the
//     evidence_locker subcollection is empty (no "Unavailable"
//     overlays, just an empty photo rail).
//
// Same safety guard pattern as seedDemoMembership / seedDemoRoleMembers:
//   - Demo-org-only.
//   - Refuses to run unless an emulator-host env var is set OR
//     project name contains "demo"/"emu"/"staging".
//   - Dry-run by default. --apply to write. --force to overwrite
//     existing fixtures (otherwise they're skipped if already
//     present).
//
// Run from next-app/:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8087 \
//   GOOGLE_APPLICATION_CREDENTIALS="" \
//     npx tsx scripts/seedDemoLifecycleFixtures.ts            # dry-run
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8087 \
//   GOOGLE_APPLICATION_CREDENTIALS="" \
//     npx tsx scripts/seedDemoLifecycleFixtures.ts --apply    # write

import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";

import { isDemoOrg } from "../src/lib/orgKind";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const ALLOW_PROD = process.argv.includes("--allow-prod");

const DEMO_ORG_ID = "demo-org";

type Phase = "field-ready-to-close" | "review-closed" | "summary-awaiting";

type Fixture = {
  incidentId: string;
  phase: Phase;
  title: string;
  jobId: string;
  jobTitle: string;
  jobStatus: "open" | "in_progress" | "review" | "approved" | "complete";
  jobReviewStatus?: "pending" | "approved" | "rejected" | "none";
  locked?: boolean;
  incidentStatus: "open" | "in_progress" | "submitted" | "closed";
};

const FIXTURES: ReadonlyArray<Fixture> = [
  // 1. Field Job approved/ready-to-close. The job is approved + locked,
  //    the incident is still "submitted" (not yet closed). Field Job
  //    page should show "Job approved" and the close-incident affordance
  //    is gated on supervisor role.
  {
    incidentId: "inc_20260429_064006_ming4g",
    phase: "field-ready-to-close",
    title: "Storm response — Pole 14A-22",
    jobId: "job_field_ready_to_close",
    jobTitle: "Replace broken pole-top pin — Pole 14A-22",
    jobStatus: "approved",
    jobReviewStatus: "approved",
    locked: true,
    incidentStatus: "submitted",
  },
  // 2. Supervisor Review closed flow. Incident is closed, job is
  //    approved + locked. Review page should render the closed-state
  //    panel without raw "Untitled incident" chrome from prior bugs.
  {
    incidentId: "inc_20260429_071222_n3ss11",
    phase: "review-closed",
    title: "Fiber splice verification — North Line Segment B",
    jobId: "job_review_closed",
    jobTitle: "Fiber splice verification — Splice cabinet NLB-04",
    jobStatus: "approved",
    jobReviewStatus: "approved",
    locked: true,
    incidentStatus: "closed",
  },
  // 3. Summary awaiting-supervisor-approval. Field crew submitted, job
  //    is in "review" (no approved/locked yet). Summary page should
  //    render the awaiting-approval banner.
  {
    incidentId: "inc_20260429_080946_qcetdv",
    phase: "summary-awaiting",
    title: "Inspection — Utility Corridor 7",
    jobId: "job_summary_awaiting",
    jobTitle: "Storm damage inspection — MP 12.4",
    jobStatus: "review",
    jobReviewStatus: "pending",
    locked: false,
    incidentStatus: "submitted",
  },
];

function ensureAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!;
  // PEAKOPS_SEED_PROJECT_DEFAULT_V1 (2026-05-06)
  // When emulator-host env vars are set but GCLOUD_PROJECT isn't,
  // firebase-admin's applicationDefault() picks an auto-detected
  // namespace that is NOT peakops-demo — and writes silently go
  // there instead of where the runbook expects. Default the
  // project explicitly so the simple invocation
  //   FIRESTORE_EMULATOR_HOST=... npx tsx scripts/seedDemo*.ts --apply
  // lands in peakops-demo every time. Caller's GCLOUD_PROJECT (if
  // set) wins.
  if (
    !process.env.GCLOUD_PROJECT &&
    !process.env.FIREBASE_PROJECT_ID &&
    !process.env.GOOGLE_CLOUD_PROJECT &&
    (process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.FIREBASE_STORAGE_EMULATOR_HOST)
  ) {
    process.env.GCLOUD_PROJECT = "peakops-demo";
  }
  return initializeApp({ credential: applicationDefault() });
}

function isSafeToSeed(): boolean {
  if (
    process.env.FIRESTORE_EMULATOR_HOST ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.FIREBASE_STORAGE_EMULATOR_HOST
  ) {
    return true;
  }
  const proj = String(
    process.env.GCLOUD_PROJECT ||
      process.env.FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      "",
  ).toLowerCase();
  if (!proj) return false;
  return proj.includes("demo") || proj.includes("emu") || proj.includes("staging");
}

async function seedOne(db: Firestore, fx: Fixture, alreadyApplied: Set<string>): Promise<void> {
  const incRef = db.collection("incidents").doc(fx.incidentId);
  const orgIncRef = db.doc(`orgs/${DEMO_ORG_ID}/incidents/${fx.incidentId}`);
  const jobRef = incRef.collection("jobs").doc(fx.jobId);

  const existing = await incRef.get();
  if (existing.exists && !FORCE) {
    console.log(`  ✓ ${fx.incidentId} already exists — pass --force to overwrite`);
    alreadyApplied.add(fx.incidentId);
    return;
  }

  const action = existing.exists ? "OVERWRITE" : "CREATE";
  console.log(`  → ${fx.incidentId} ${action} phase=${fx.phase} status=${fx.incidentStatus}`);
  if (!APPLY) return;

  const now = FieldValue.serverTimestamp();
  const closedFields =
    fx.incidentStatus === "closed"
      ? { closedAt: now, closedBy: "supe_smoke" }
      : {};
  const submittedFields =
    fx.incidentStatus === "submitted" || fx.incidentStatus === "closed"
      ? { submittedAt: now, submittedBy: "field_smoke" }
      : {};

  // Top-level incident doc. Lifecycle callables read from here.
  const incDoc = {
    incidentId: fx.incidentId,
    orgId: DEMO_ORG_ID,
    title: fx.title,
    status: fx.incidentStatus,
    createdAt: now,
    createdBy: "dev-admin",
    updatedAt: now,
    ...submittedFields,
    ...closedFields,
  };
  await incRef.set(incDoc, { merge: true });

  // Per-org mirror so getIncidentV1's primary read (orgs path) also
  // resolves. Same shape; createIncidentV1 dual-writes the same way.
  await orgIncRef.set(incDoc, { merge: true });

  // Job doc. State varies by phase.
  const jobDoc: Record<string, unknown> = {
    id: fx.jobId,
    incidentId: fx.incidentId,
    orgId: DEMO_ORG_ID,
    assignedOrgId: DEMO_ORG_ID,
    title: fx.jobTitle,
    status: fx.jobStatus,
    locked: !!fx.locked,
    createdAt: now,
    createdBy: "dev-admin",
    updatedAt: now,
  };
  if (fx.jobReviewStatus) jobDoc.reviewStatus = fx.jobReviewStatus;
  if (fx.jobStatus === "approved") {
    jobDoc.approvedAt = now;
    jobDoc.approvedBy = "supe_smoke";
  }
  await jobRef.set(jobDoc, { merge: true });

  // Minimal timeline trail. Three events on the canonical lifecycle:
  // created → submitted → approved/closed. The Field/Review/Summary
  // pages each render the timeline subset relevant to their phase.
  const timeline = incRef.collection("timeline_events");
  const baseTl = { orgId: DEMO_ORG_ID, incidentId: fx.incidentId, occurredAt: now };
  await timeline.doc("seed_t0_created").set(
    { ...baseTl, id: "seed_t0_created", type: "INCIDENT_CREATED", actor: "dev-admin", title: "Incident created" },
    { merge: true },
  );
  if (fx.incidentStatus === "submitted" || fx.incidentStatus === "closed") {
    await timeline.doc("seed_t1_submitted").set(
      {
        ...baseTl,
        id: "seed_t1_submitted",
        type: "FIELD_SUBMITTED",
        actor: "field_smoke",
        title: "Field session submitted",
      },
      { merge: true },
    );
  }
  if (fx.jobStatus === "approved") {
    await timeline.doc(`seed_t2_job_approved_${fx.jobId}`).set(
      {
        ...baseTl,
        id: `seed_t2_job_approved_${fx.jobId}`,
        type: "job_approved",
        refId: fx.jobId,
        actor: "supe_smoke",
        title: "Job approved",
        meta: { from: "review", to: "approved" },
      },
      { merge: true },
    );
  }
  if (fx.incidentStatus === "closed") {
    await timeline.doc("seed_t3_closed").set(
      {
        ...baseTl,
        id: "seed_t3_closed",
        type: "incident_closed",
        actor: "supe_smoke",
        title: "Incident closed",
      },
      { merge: true },
    );
  }
}

async function main(): Promise<void> {
  if (!isDemoOrg(DEMO_ORG_ID)) {
    console.error(
      `[seed] FATAL: ${DEMO_ORG_ID} is not classified as a demo org. Refusing.`,
    );
    process.exit(2);
  }
  if (!ALLOW_PROD && !isSafeToSeed()) {
    console.error(
      "[seed] FATAL: project does not look like a demo/emulator/staging environment. " +
        "Pass --allow-prod to override (you almost never want to do this).",
    );
    process.exit(2);
  }

  ensureAdminApp();
  const db = getFirestore();

  console.log(
    `[seed] mode=${APPLY ? "APPLY" : "dry-run"} force=${FORCE ? "yes" : "no"} ` +
      `org=${DEMO_ORG_ID} fixtures=${FIXTURES.length}`,
  );

  const alreadyApplied = new Set<string>();
  for (const fx of FIXTURES) {
    await seedOne(db, fx, alreadyApplied);
  }

  const writes = FIXTURES.length - alreadyApplied.size;
  console.log(
    `[seed] ${APPLY ? "wrote" : "would write"} ${writes} fixture(s); ` +
      `${alreadyApplied.size} already present.`,
  );
  if (!APPLY) {
    console.log("[seed] dry-run only. Pass --apply to write.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  });
