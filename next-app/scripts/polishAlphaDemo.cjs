// PEAKOPS_DEMO_POLISH_V1 (2026-05-12) — Slice Demo Polish 1.0.
//
// One-off operator script: polishes the canonical telecom alpha
// demo incident so it reads as a real operational record instead
// of an internal smoke test. The Demo Polish 1.0 audit found:
//   - alpha evidence photo is a 70-byte placeholder (the original
//     "alpha-smoke.png" Nick uploaded during early lifecycle work)
//   - alpha incident notes read as dev-test copy
//     ("Internal alpha field note — splice verification smoke test.")
//   - alpha job title carries an "— Internal Alpha" suffix that
//     pegs it as an internal record, not a buyer-facing one
//
// Muni + utility seeds are already polish-quality (real PNGs, real
// field-authentic narratives) so this script targets ALPHA ONLY.
//
// What it writes (when --apply is set):
//   1. Re-uploads dev-assets/demo-evidence/13.png to the existing
//      alpha evidence Storage path (same path — preserves the
//      evidence_locker doc's file.storagePath reference). Renamed
//      to fiber-splice-demo.png so originalName/filename read as
//      a field photo, not a smoke test.
//   2. Updates `incidents/<alpha>/evidence_locker/<id>` file
//      sub-doc: originalName, filename, exportName regenerated
//      with the new filename.
//   3. Updates `incidents/<alpha>/notes/main`: replaces the 59-char
//      placeholder with a field-authentic splice-verification
//      narrative + a clean siteNotes line.
//   4. Updates `incidents/<alpha>/jobs/<id>`: drops the
//      "— Internal Alpha" suffix from the title.
//
// What it deliberately does NOT do:
//   - Does not change incident timestamps (alpha's lifecycle
//     already spans ~5 hours which reads realistically).
//   - Does not touch alpha branding.logoUrl (explicit guard).
//   - Does not touch packetMeta. The existing exported ZIP at
//     exports/incidents/.../*.zip still downloads. After this
//     script runs, Nick can hit Regenerate once to bake the new
//     photo + notes + task title into a fresh signed ZIP.
//   - Does not touch any other org. Hard-refuses muni + utility +
//     demo-org orgIds even if mistyped.
//
// Idempotent + dry-run by default. With --apply it MERGE-writes
// the doc fields and overwrites the Storage file at the same
// path.
//
// Usage:
//   node scripts/polishAlphaDemo.cjs              # dry-run
//   node scripts/polishAlphaDemo.cjs --apply      # write

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");

const ORG = "peakops-internal-alpha";
const INCIDENT_ID = "inc_20260508_121451_acnew0";

// Refuse anything but the alpha org. The other demo orgs already
// hold polish-quality content.
const PROTECTED_OTHER_ORGS = new Set([
  "peakops-internal-muni",
  "peakops-internal-utility",
  "demo-org",
]);
if (PROTECTED_OTHER_ORGS.has(ORG)) {
  console.error(`[polish-alpha] FATAL — refusing to write to protected org ${ORG}.`);
  process.exit(2);
}

const NEW_INCIDENT_NOTES =
  "Splice verification at the North Line Segment B cabinet. Crew arrived " +
  "during the planned maintenance window. OTDR sweep clean across all six " +
  "active fibers; loss readings within spec on both directions. Re-bonded " +
  "the cabinet's ground strap after the inspection — corrosion observed at " +
  "the lug had been flagged on the prior visit. Splice tray seals reseated, " +
  "cabinet door gasket inspected and resealed. No interruption to live " +
  "traffic. Documented for the operational record.";

const NEW_SITE_NOTES =
  "Cabinet exterior in good condition. Adjacent pole-mount handhole dry; " +
  "no water intrusion. Right-of-way clear of vegetation.";

const NEW_JOB_TITLE = "Splice cabinet inspection — North Line Segment B";

const REPLACEMENT_PHOTO_SOURCE = path.resolve(
  __dirname, "..", "dev-assets", "demo-evidence", "13.png",
);
const REPLACEMENT_PHOTO_NAME = "fiber-splice-demo.png";

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
  return admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
    storageBucket: `${sa.project_id}.firebasestorage.app`,
  });
}

(async () => {
  const sa = loadServiceAccount();
  if (!sa) {
    console.error("[polish-alpha] no service account found");
    process.exit(1);
  }
  ensureAdminApp(sa);
  console.log(`[polish-alpha] project=${sa.project_id} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[polish-alpha] org=${ORG} incident=${INCIDENT_ID}`);

  if (!fs.existsSync(REPLACEMENT_PHOTO_SOURCE)) {
    console.error(`[polish-alpha] FAIL — replacement photo missing: ${REPLACEMENT_PHOTO_SOURCE}`);
    process.exit(3);
  }
  const photoBytes = fs.readFileSync(REPLACEMENT_PHOTO_SOURCE);
  console.log(`[polish-alpha] replacement photo: ${REPLACEMENT_PHOTO_SOURCE} (${photoBytes.length} bytes)`);

  const db = admin.firestore();

  // Load the single evidence_locker doc on the alpha incident so we
  // can resolve its storagePath (preserve the existing path; only
  // the bytes + originalName/filename change).
  const evSnap = await db.collection(`incidents/${INCIDENT_ID}/evidence_locker`).get();
  if (evSnap.empty) {
    console.error(`[polish-alpha] FAIL — no evidence_locker docs on ${INCIDENT_ID}.`);
    process.exit(3);
  }
  if (evSnap.size > 1) {
    console.error(`[polish-alpha] FAIL — alpha incident has ${evSnap.size} evidence docs (expected 1).`);
    process.exit(3);
  }
  const evDoc = evSnap.docs[0];
  const evData = evDoc.data() || {};
  const file = evData.file || {};
  const storagePath = String(file.storagePath || "").trim();
  if (!storagePath) {
    console.error(`[polish-alpha] FAIL — evidence doc has no file.storagePath.`);
    process.exit(3);
  }
  console.log(`[polish-alpha] target storagePath: ${storagePath}`);

  // Load the single job doc to refresh its title.
  const jobSnap = await db.collection(`incidents/${INCIDENT_ID}/jobs`).get();
  if (jobSnap.empty) {
    console.error(`[polish-alpha] FAIL — no jobs on ${INCIDENT_ID}.`);
    process.exit(3);
  }
  if (jobSnap.size > 1) {
    console.error(`[polish-alpha] FAIL — alpha incident has ${jobSnap.size} jobs (expected 1).`);
    process.exit(3);
  }
  const jobDoc = jobSnap.docs[0];
  const jobData = jobDoc.data() || {};
  console.log(`[polish-alpha] target job: ${jobDoc.id} (current title: "${jobData.title}")`);

  // Notes doc check
  const notesRef = db.doc(`incidents/${INCIDENT_ID}/notes/main`);
  const notesSnap = await notesRef.get();
  const notesData = notesSnap.exists ? notesSnap.data() || {} : null;
  console.log(`[polish-alpha] notes/main current incidentNotes: "${String(notesData ? notesData.incidentNotes : "")}"`);

  // Regenerate exportName with the new filename, preserving the
  // INC/SES/PHASE/LBL/UTC/GPS scaffold the field-upload flow uses.
  const sessionId = String(evData.sessionId || "ses_unknown");
  const phase = String(evData.phase || "INSPECTION");
  const labels = Array.isArray(evData.labels) ? evData.labels : ["DAMAGE"];
  const labelCsv = labels.join("-");
  let utcStamp = "UTC-NA";
  if (file.exportName && typeof file.exportName === "string") {
    const m = /UTC-([0-9TZ]+)/.exec(file.exportName);
    if (m) utcStamp = `UTC-${m[1]}`;
  }
  const newExportName =
    `INC-${INCIDENT_ID}__SES-${sessionId}__PHASE-${phase}__LBL-${labelCsv}` +
    `__${utcStamp}__GPS-NA__${REPLACEMENT_PHOTO_NAME}`;

  // ── PLAN ────────────────────────────────────────────────────
  console.log(`\n[polish-alpha] PLAN`);
  console.log(`  STORAGE  ${storagePath}`);
  console.log(`           ← overwrite with ${REPLACEMENT_PHOTO_SOURCE} (${photoBytes.length} bytes)`);
  console.log(`  EVIDENCE incidents/${INCIDENT_ID}/evidence_locker/${evDoc.id}`);
  console.log(`           file.originalName: "${file.originalName}" → "${REPLACEMENT_PHOTO_NAME}"`);
  console.log(`           file.filename:     "${file.filename}" → "${REPLACEMENT_PHOTO_NAME}"`);
  console.log(`           file.exportName:   updated`);
  console.log(`  JOB      incidents/${INCIDENT_ID}/jobs/${jobDoc.id}`);
  console.log(`           title: "${jobData.title}" → "${NEW_JOB_TITLE}"`);
  console.log(`  NOTES    incidents/${INCIDENT_ID}/notes/main`);
  console.log(`           incidentNotes: ${NEW_INCIDENT_NOTES.length} chars`);
  console.log(`           siteNotes:     ${NEW_SITE_NOTES.length} chars`);

  if (!APPLY) {
    console.log("\n[polish-alpha] DRY RUN — pass --apply to write.");
    process.exit(0);
  }

  // ── APPLY ───────────────────────────────────────────────────

  // 1) Storage overwrite at the same path.
  try {
    const bucket = admin.storage().bucket();
    await bucket.file(storagePath).save(photoBytes, {
      contentType: "image/png",
      resumable: false,
      metadata: {
        contentType: "image/png",
        cacheControl: "public, max-age=3600",
        metadata: {
          source: "demo-polish-v1",
          incidentId: INCIDENT_ID,
          orgId: ORG,
          replaces: "alpha-smoke.png",
        },
      },
    });
    console.log(`[polish-alpha] storage overwrite OK`);
  } catch (e) {
    console.error(`[polish-alpha] storage overwrite FAIL: ${e && e.message ? e.message : e}`);
    process.exit(4);
  }

  // 2) Firestore updates (one batch).
  const batch = db.batch();
  batch.update(evDoc.ref, {
    "file.originalName": REPLACEMENT_PHOTO_NAME,
    "file.filename": REPLACEMENT_PHOTO_NAME,
    "file.exportName": newExportName,
    "file.conversionUpdatedAt": admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.update(jobDoc.ref, {
    title: NEW_JOB_TITLE,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(
    notesRef,
    {
      incidentNotes: NEW_INCIDENT_NOTES,
      siteNotes: NEW_SITE_NOTES,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  try {
    await batch.commit();
  } catch (e) {
    console.error(`[polish-alpha] Firestore batch commit FAIL: ${e && e.message ? e.message : e}`);
    process.exit(5);
  }

  console.log(`\n[polish-alpha] write OK.`);
  console.log(`[polish-alpha] Verify in Chrome:`);
  console.log(
    `  https://app.peakops.app/incidents/${INCIDENT_ID}/summary?orgId=${ORG}`,
  );
  console.log(`[polish-alpha] After eyeball, optionally click Regenerate to rebuild the`);
  console.log(`[polish-alpha] signed ZIP with the new photo + notes + task title baked in.`);
  process.exit(0);
})().catch((e) => {
  console.error(`[polish-alpha] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
