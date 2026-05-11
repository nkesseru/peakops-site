// PEAKOPS_DEMO_ARTIFACT_SEEDING_V1 (2026-05-11) — Slice Demo Artifact 1.0.
//
// One-off operator script: seeds ONE polished closed-state incident in
// an internal QA org so the org has a real artifact for buyer demos.
// Mirrors the schema of the existing telecom alpha incident
// (inc_20260508_121451_acnew0) — same dual-write to top-level
// `incidents/{id}` and org-scoped `orgs/{org}/incidents/{id}`,
// matching subcollection layout (jobs / evidence_locker / notes),
// matching evidence + job document shapes.
//
// What this script writes (idempotent — MERGE-write each doc, but
// only when the incident doesn't already exist for that org; an
// existing seeded incident is treated as already-done):
//   1. incidents/{newId}                              (top-level canonical)
//   2. orgs/{orgId}/incidents/{newId}                 (org-scoped mirror)
//   3. incidents/{newId}/jobs/{jobId}                 (approved + locked)
//   4. incidents/{newId}/evidence_locker/{evId}       (1 photo metadata)
//   5. incidents/{newId}/notes/main                   (field + site notes)
//   + Storage upload at:
//     orgs/{orgId}/incidents/{newId}/uploads/{sessionId}/{ts}__demo.png
//
// What this script deliberately does NOT do:
//   - does not write packetMeta. The buyer (or operator) clicks
//     "Generate Report" once on the Summary page to produce the real
//     cryptographically-signed ZIP via exportIncidentPacketV1. The
//     authentic packet is preferred over a faked one.
//   - does not seed timeline events. The codebase reconstructs the
//     timeline from incident + job timestamps and emits it through
//     getTimelineEventsV1; no separate timeline docs are needed.
//   - does not modify claims, rules, or auth.
//   - does not touch peakops-internal-alpha, peakops-internal-muni
//     (when seeding utility), or peakops-internal-utility (when
//     seeding muni), or demo-org.
//   - does not create more than one incident per org. A second
//     invocation against the same org+industry combo is a no-op.
//
// Usage:
//   node scripts/seedDemoIncident.cjs --org=peakops-internal-muni     --industry=municipality
//   node scripts/seedDemoIncident.cjs --org=peakops-internal-utility  --industry=utilities
//
// Add --apply to actually write. Without --apply the script prints
// the plan only.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const admin = require("firebase-admin");

function getArg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : "";
}

const ORG = String(getArg("org") || "").trim();
const INDUSTRY = String(getArg("industry") || "").trim().toLowerCase();
const APPLY = process.argv.includes("--apply");

if (!ORG || !INDUSTRY) {
  console.error(
    "Usage: node scripts/seedDemoIncident.cjs --org=<orgId> --industry=<municipality|utilities> [--apply]",
  );
  process.exit(2);
}
if (!["municipality", "utilities"].includes(INDUSTRY)) {
  console.error(`--industry must be "municipality" or "utilities" (got ${JSON.stringify(INDUSTRY)})`);
  process.exit(2);
}

// Hard-refuse protected orgs even if mistyped.
const PROTECTED_ORGS = new Set(["peakops-internal-alpha", "demo-org"]);
if (PROTECTED_ORGS.has(ORG)) {
  console.error(`[seed-demo] FATAL — refusing to seed protected org ${ORG}.`);
  process.exit(2);
}

// PEAKOPS_DEMO_ARTIFACT_SEEDING_V1 — industry-flavored payload.
// Two configurations: stormwater (muni) and outage response (utility).
// Notes deliberately read as real operational narratives — no lorem
// ipsum, no random placeholders.
const PAYLOADS = {
  municipality: {
    title: "Stormwater inspection — 3rd Ave catch basin",
    location: "3rd Ave · Catch basin CB-12",
    priority: "normal",
    jobType: "inspection",
    displayType: "Stormwater",
    jobTitle: "Inspect catch basin CB-12 condition",
    incidentNotes:
      "Catch basin CB-12 routine inspection. Inlet grate is intact, no visible " +
      "structural damage. Light sediment accumulation in the sump (<30% capacity). " +
      "Downstream pipe runs clear on visual inspection. Recommend scheduling " +
      "routine vactor cleanout in the next inspection cycle. No immediate action " +
      "required; right-of-way is clear and unobstructed.",
    siteNotes:
      "Adjacent curb in good condition. Weather: clear, dry. No standing water observed.",
    photoCaption: "DEMO STORMWATER",
    photoSourceFile: "8.png",
    evidenceLabels: ["INSPECTION"],
    phase: "INSPECTION",
  },
  utilities: {
    title: "Utility outage response — North feeder line",
    location: "North feeder line · Section 14A",
    priority: "urgent",
    jobType: "damage",
    displayType: "Outage",
    jobTitle: "Restore service on North feeder line, Section 14A",
    incidentNotes:
      "Storm-related outage reported on the North feeder line, Section 14A. " +
      "Crew arrived on site within the response window. Identified primary cause " +
      "as a downed conductor at pole 22-NF, span 14A-3. Cleared the line, replaced " +
      "the damaged conductor, and restored service. Field inspection confirmed " +
      "transformer and protective devices in good condition. All customers " +
      "downstream of pole 22-NF restored. Final restoration documented for the " +
      "operational record.",
    siteNotes:
      "Right-of-way access clear. Adjacent vegetation flagged for routine trim cycle.",
    photoCaption: "DEMO UTILITY OUTAGE",
    photoSourceFile: "12.png",
    evidenceLabels: ["DAMAGE"],
    phase: "INSPECTION",
  },
};

const payload = PAYLOADS[INDUSTRY];

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

function ensureAdminApp(sa) {
  if (admin.apps.length > 0) return admin.apps[0];
  // Set the default storage bucket so admin.storage().bucket() resolves
  // without needing a name. peakops-pilot uses the firebasestorage.app
  // bucket suffix (verified by reading the alpha evidence file metadata).
  return admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
    storageBucket: `${sa.project_id}.firebasestorage.app`,
  });
}

// 20-char Firestore-style auto-ID (mirrors the format observed on the
// alpha incident's job + evidence sub-doc IDs).
function autoId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 20; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

// Incident ID format mirrors the alpha pattern:
//   inc_{YYYYMMDD}_{HHMMSS}_{6 lowercase hex}
function generateIncidentId(date) {
  const y = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const HH = String(date.getUTCHours()).padStart(2, "0");
  const MM = String(date.getUTCMinutes()).padStart(2, "0");
  const SS = String(date.getUTCSeconds()).padStart(2, "0");
  const rand = crypto.randomBytes(3).toString("hex"); // 6 hex chars
  return `inc_${y}${mm}${dd}_${HH}${MM}${SS}_${rand}`;
}

// Session ID format mirrors alpha evidence's sessionId:
//   ses_{YYYYMMDDTHHMMSSZ}_{8 hex}
function generateSessionId(date) {
  const y = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const HH = String(date.getUTCHours()).padStart(2, "0");
  const MM = String(date.getUTCMinutes()).padStart(2, "0");
  const SS = String(date.getUTCSeconds()).padStart(2, "0");
  const rand = crypto.randomBytes(4).toString("hex"); // 8 hex chars
  return `ses_${y}${mm}${dd}T${HH}${MM}${SS}Z_${rand}`;
}

function utcStamp(date) {
  const y = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const HH = String(date.getUTCHours()).padStart(2, "0");
  const MM = String(date.getUTCMinutes()).padStart(2, "0");
  const SS = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${mm}${dd}T${HH}${MM}${SS}Z`;
}

(async () => {
  const sa = loadServiceAccount();
  if (!sa) {
    console.error("[seed-demo] no service account found");
    process.exit(1);
  }
  ensureAdminApp(sa);

  const projectId = sa.project_id;
  console.log(`[seed-demo] project=${projectId} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[seed-demo] org=${ORG} industry=${INDUSTRY}`);
  console.log(`[seed-demo] title="${payload.title}"`);

  const db = admin.firestore();

  // 1) Idempotency check — refuse to seed a second incident for this
  // org. We look for any existing seed-marked incident in the org's
  // subcollection. The marker is the `source: "demo-artifact-seed"`
  // field we'll write below.
  const existingQuery = await db
    .collection(`orgs/${ORG}/incidents`)
    .where("source", "==", "demo-artifact-seed")
    .limit(1)
    .get();
  if (!existingQuery.empty) {
    const existing = existingQuery.docs[0];
    const data = existing.data() || {};
    console.log(
      `[seed-demo] already-seeded — orgs/${ORG} has a demo incident: ${existing.id} ("${data.title}")`,
    );
    console.log(`[seed-demo] no-op. delete that doc first if you want to re-seed.`);
    process.exit(0);
  }

  // 2) Verify the photo source exists.
  const photoSourcePath = path.resolve(
    __dirname,
    "..",
    "dev-assets",
    "demo-evidence",
    payload.photoSourceFile,
  );
  if (!fs.existsSync(photoSourcePath)) {
    console.error(`[seed-demo] FAIL — demo photo not found: ${photoSourcePath}`);
    process.exit(3);
  }
  const photoBytes = fs.readFileSync(photoSourcePath);
  console.log(
    `[seed-demo] demo photo: ${photoSourcePath} (${photoBytes.length} bytes)`,
  );

  // 3) Plan timestamps for a realistic lifecycle.
  //    createdAt T (now-2h), inProgressAt T+5m, evidence storedAt T+30m,
  //    completedAt T+1h, submittedAt T+1h5m, approvedAt T+1h30m, closedAt T+1h35m.
  const now = new Date();
  const createdAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const inProgressAt = new Date(createdAt.getTime() + 5 * 60 * 1000);
  const evidenceStoredAt = new Date(createdAt.getTime() + 30 * 60 * 1000);
  const completedAt = new Date(createdAt.getTime() + 60 * 60 * 1000);
  const submittedAt = new Date(createdAt.getTime() + 65 * 60 * 1000);
  const approvedAt = new Date(createdAt.getTime() + 90 * 60 * 1000);
  const closedAt = new Date(createdAt.getTime() + 95 * 60 * 1000);

  // 4) Generate IDs.
  const incidentId = generateIncidentId(createdAt);
  const jobId = autoId();
  const evidenceId = autoId();
  const sessionId = generateSessionId(evidenceStoredAt);
  console.log(`[seed-demo] incidentId=${incidentId}`);
  console.log(`[seed-demo] jobId=${jobId} evidenceId=${evidenceId}`);
  console.log(`[seed-demo] sessionId=${sessionId}`);

  // 5) Resolve admin UID (used as createdBy / completedBy / approvedBy /
  // closedBy on every doc). Reads the org's ownerUserId; falls back to
  // the static internal-qa-bootstrap uid if absent.
  const orgSnap = await db.doc(`orgs/${ORG}`).get();
  const orgData = orgSnap.exists ? orgSnap.data() || {} : {};
  const adminUid = String(orgData.ownerUserId || "").trim() || "qTZahBZ59UTHj0CGNSdjF8ivyhX2";
  const adminEmail = "nicholaskesseru@gmail.com";
  console.log(`[seed-demo] adminUid=${adminUid}`);

  const bucket = `${projectId}.firebasestorage.app`;
  const photoOriginal = `${INDUSTRY === "municipality" ? "stormwater" : "outage"}-demo.png`;
  const photoStoragePath =
    `orgs/${ORG}/incidents/${incidentId}/uploads/${sessionId}/` +
    `${utcStamp(evidenceStoredAt)}__${photoOriginal}`;
  console.log(`[seed-demo] storage bucket=${bucket}`);
  console.log(`[seed-demo] storage path=${photoStoragePath}`);

  // ── Plan: incident doc (canonical shape — written to both paths) ────
  const incidentDoc = {
    orgId: ORG,
    incidentId,
    title: payload.title,
    status: "closed",
    priority: payload.priority,
    location: payload.location,
    jobType: payload.jobType,
    displayType: payload.displayType,
    notes: payload.incidentNotes,
    filingTypesRequired: [],
    createdAt: admin.firestore.Timestamp.fromDate(createdAt),
    inProgressAt: admin.firestore.Timestamp.fromDate(inProgressAt),
    submittedAt: admin.firestore.Timestamp.fromDate(submittedAt),
    closedAt: admin.firestore.Timestamp.fromDate(closedAt),
    updatedAt: admin.firestore.Timestamp.fromDate(closedAt),
    createdBy: { uid: adminUid, email: adminEmail, orgId: ORG },
    submittedBy: { uid: adminUid, email: adminEmail, orgId: ORG },
    closedBy: { uid: adminUid, email: adminEmail, orgId: ORG },
    source: "demo-artifact-seed",
  };

  // ── Plan: job doc (matches alpha shape — approved + locked) ────────
  const jobDoc = {
    id: jobId,
    incidentId,
    orgId: ORG,
    assignedOrgId: ORG,
    title: payload.jobTitle,
    status: "approved",
    reviewStatus: "approved",
    locked: true,
    createdAt: admin.firestore.Timestamp.fromDate(createdAt),
    createdBy: adminUid,
    completedAt: admin.firestore.Timestamp.fromDate(completedAt),
    completedBy: { uid: adminUid, email: adminEmail, orgId: ORG },
    approvedAt: admin.firestore.Timestamp.fromDate(approvedAt),
    approvedBy: adminUid,
    updatedAt: admin.firestore.Timestamp.fromDate(approvedAt),
  };

  // ── Plan: evidence_locker doc (matches alpha shape) ────────────────
  const exportNameTs = utcStamp(evidenceStoredAt);
  const labelCsv = payload.evidenceLabels.join("-");
  const evidenceDoc = {
    evidenceId,
    incidentId,
    orgId: ORG,
    jobId,
    evidence: { jobId },
    sessionId,
    phase: payload.phase,
    labels: payload.evidenceLabels,
    notes: "",
    gps: null,
    version: 1,
    createdAt: admin.firestore.Timestamp.fromDate(evidenceStoredAt),
    storedAt: admin.firestore.Timestamp.fromDate(evidenceStoredAt),
    file: {
      bucket,
      storagePath: photoStoragePath,
      originalName: photoOriginal,
      filename: photoOriginal,
      contentType: "image/png",
      conversionStatus: "n/a",
      conversionUpdatedAt: admin.firestore.Timestamp.fromDate(evidenceStoredAt),
      exportName:
        `INC-${incidentId}__SES-${sessionId}__PHASE-${payload.phase}__LBL-${labelCsv}` +
        `__UTC-${exportNameTs}__GPS-NA__${photoOriginal}`,
    },
  };

  // ── Plan: notes doc ────────────────────────────────────────────────
  const notesDoc = {
    incidentNotes: payload.incidentNotes,
    siteNotes: payload.siteNotes,
    updatedAt: admin.firestore.Timestamp.fromDate(submittedAt),
    updatedBy: { uid: adminUid, email: adminEmail, orgId: ORG },
  };

  console.log(`\n[seed-demo] PLAN`);
  console.log(`  incidents/${incidentId} ← status=closed, title="${incidentDoc.title}"`);
  console.log(`  orgs/${ORG}/incidents/${incidentId} ← same (org-scoped mirror)`);
  console.log(`  incidents/${incidentId}/jobs/${jobId} ← status=approved, locked=true`);
  console.log(`  incidents/${incidentId}/evidence_locker/${evidenceId} ← 1 photo, labels=[${labelCsv}]`);
  console.log(`  incidents/${incidentId}/notes/main ← incidentNotes + siteNotes`);
  console.log(`  Storage: ${bucket}/${photoStoragePath} ← ${photoBytes.length} bytes`);

  if (!APPLY) {
    console.log("\n[seed-demo] DRY RUN — pass --apply to write.");
    process.exit(0);
  }

  // ── 1) Storage upload (do this first; if it fails we don't write
  //       Firestore docs that point at a non-existent file). ────────
  try {
    const storageBucket = admin.storage().bucket();
    const fileRef = storageBucket.file(photoStoragePath);
    await fileRef.save(photoBytes, {
      contentType: "image/png",
      resumable: false,
      metadata: {
        contentType: "image/png",
        cacheControl: "public, max-age=3600",
        metadata: {
          source: "demo-artifact-seed",
          incidentId,
          orgId: ORG,
        },
      },
    });
    console.log(`[seed-demo] storage upload OK`);
  } catch (e) {
    console.error(`[seed-demo] storage upload FAIL: ${e && e.message ? e.message : e}`);
    process.exit(4);
  }

  // ── 2) Firestore writes (atomic batch where possible) ─────────────
  const batch = db.batch();
  const topRef = db.doc(`incidents/${incidentId}`);
  const orgRef = db.doc(`orgs/${ORG}/incidents/${incidentId}`);
  const jobRef = db.doc(`incidents/${incidentId}/jobs/${jobId}`);
  const evRef = db.doc(`incidents/${incidentId}/evidence_locker/${evidenceId}`);
  const notesRef = db.doc(`incidents/${incidentId}/notes/main`);

  batch.set(topRef, incidentDoc);
  batch.set(orgRef, incidentDoc);
  batch.set(jobRef, jobDoc);
  batch.set(evRef, evidenceDoc);
  batch.set(notesRef, notesDoc);

  try {
    await batch.commit();
  } catch (e) {
    console.error(`[seed-demo] Firestore batch commit FAIL: ${e && e.message ? e.message : e}`);
    process.exit(5);
  }

  console.log(`\n[seed-demo] write OK.`);
  console.log(`[seed-demo] Demo walkthrough URLs:`);
  const base = "https://app.peakops.app";
  console.log(`  Jobs index:    ${base}/incidents?orgId=${ORG}`);
  console.log(`  Incident:      ${base}/incidents/${incidentId}?orgId=${ORG}`);
  console.log(`  Summary:       ${base}/incidents/${incidentId}/summary?orgId=${ORG}`);
  console.log(`  Review:        ${base}/incidents/${incidentId}/review?orgId=${ORG}`);
  console.log(`\n[seed-demo] To produce the real signed-ZIP packet, open the Summary URL above`);
  console.log(`[seed-demo] and click "Generate Report" once. exportIncidentPacketV1 writes`);
  console.log(`[seed-demo] packetMeta back to the incident doc and Download Report becomes live.`);
  process.exit(0);
})().catch((e) => {
  console.error(`[seed-demo] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
