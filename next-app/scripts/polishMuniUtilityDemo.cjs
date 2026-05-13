// PEAKOPS_DEMO_REALISM_POLISH_V1_1 (2026-05-12) — Slice Demo
// Realism Polish 1.1.
//
// Sister script to polishAlphaDemo.cjs. Brings the Municipality
// and Utility demo incidents up to the same field-authentic
// realism level as the polished Telecom alpha (richer notes,
// concise site-notes addendum, spec-compliant task titles).
//
// Photos: the v1.0 audit found muni at 463 KB and utility at
// 291 KB — both are real PNGs from dev-assets/demo-evidence/,
// not placeholders. This script leaves photos intact; the spec
// said to upgrade only if "current photos are weak", and a
// quarter-MB real photo isn't weak. If buyer feedback later
// indicates the visual CONTENT doesn't match the industry, a
// targeted file swap is a one-line change.
//
// What it writes (when --apply is set) for the targeted org:
//   1. incidents/<id>/notes/main → richer incidentNotes +
//      siteNotes (drafted to match the field-authentic tone of
//      the alpha polish — concrete observations, crew
//      shorthand, no AI fluff or repetitive structure).
//   2. incidents/<id>/jobs/<jobId> → task title rewritten per
//      Demo Realism Polish 1.1 spec.
//
// What it deliberately does NOT do:
//   - Does not touch the Storage photo on either demo (already
//     real PNGs).
//   - Does not touch incident timestamps (5min → 65min → 95min
//     lifecycle spread reads believably; alpha is the only
//     incident with a longer spread because its lifecycle was
//     genuine, not seeded).
//   - Does not touch peakops-internal-alpha. Hard-refuses it
//     even if --kind=alpha is mistyped.
//   - Does not touch packetMeta. Muni + utility haven't had
//     Generate Report run yet, so there's nothing stale to
//     invalidate. Their next Generate Report click will bake
//     the polished copy into the signed ZIP.
//
// Usage:
//   node scripts/polishMuniUtilityDemo.cjs --kind=muni
//   node scripts/polishMuniUtilityDemo.cjs --kind=utility
//   Add --apply to write.

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
  console.error("Usage: node scripts/polishMuniUtilityDemo.cjs --kind=muni|utility [--apply]");
  process.exit(2);
}

// Per-kind targets. Hard-refuses alpha or demo-org.
const TARGETS = {
  muni: {
    org: "peakops-internal-muni",
    id: "inc_20260511_205431_773c1b",
    newJobTitle: "Catch basin inspection — 3rd Ave CB-12",
    newIncidentNotes:
      "Routine inspection at catch basin CB-12 on the 3rd Ave maintenance " +
      "route. Crew arrived ahead of the weekly sweep. Inlet grate intact, " +
      "no impact damage; frame seated flush with the curb line. Sump roughly " +
      "30% capacity — silt and organic leaf debris, no oily sheen. Downstream " +
      "pipe runs clear on visual; trickle flow from residual prior-week rain. " +
      "Cones placed during the inspection window for pedestrian safety. Next-" +
      "cycle vactor cleanout recommended on the area schedule. Public-works " +
      "closeout documented.",
    newSiteNotes:
      "Curb line in good condition. Light leaf litter cleared from the grate. " +
      "No standing water; flow trickle downstream. Pedestrian path clear of " +
      "tools and cones at sign-off.",
  },
  utility: {
    org: "peakops-internal-utility",
    id: "inc_20260511_205446_c6bf95",
    newJobTitle: "Feeder isolation — North line Section 14A",
    newIncidentNotes:
      "Outage reported on the North feeder line at 06:42. SCADA confirmed " +
      "loss-of-load on Section 14A. Crew isolated the section at the " +
      "substation switch-house, locked out the upstream breaker for crew " +
      "safety, and drove the corridor to pole 22-NF. Primary cause: conductor " +
      "down between spans 14A-3 and 14A-4 from a windfall limb. Cleared the " +
      "limb, replaced the 1/0 ACSR conductor across the span, re-sagged to " +
      "spec. Walked the line back to the recloser before re-energizing; load " +
      "restored at 09:18. AMI ping confirmed downstream meter recovery. " +
      "Vegetation crew tasked with corridor trim follow-up.",
    newSiteNotes:
      "Substation switch-house access clear, lockout/tagout in place during " +
      "the repair. Pole 22-NF undamaged post-repair. Transformer T-22 visual " +
      "clean — no signs of stress or leak. Vegetation along span 14A-3 " +
      "flagged for the trim cycle.",
  },
};

const target = TARGETS[KIND];

// Belt-and-braces guard.
if (target.org === "peakops-internal-alpha" || target.org === "demo-org") {
  console.error(`[polish-1.1] FATAL — refusing to write to protected org ${target.org}.`);
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

function ensureAdminApp(sa) {
  if (admin.apps.length > 0) return admin.apps[0];
  return admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
  });
}

(async () => {
  const sa = loadServiceAccount();
  if (!sa) {
    console.error("[polish-1.1] no service account found");
    process.exit(1);
  }
  ensureAdminApp(sa);
  console.log(`[polish-1.1] project=${sa.project_id} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[polish-1.1] kind=${KIND} org=${target.org} incident=${target.id}`);

  const db = admin.firestore();

  // Resolve the single job doc on the incident.
  const jobSnap = await db.collection(`incidents/${target.id}/jobs`).get();
  if (jobSnap.empty) {
    console.error(`[polish-1.1] FAIL — no jobs on ${target.id}.`);
    process.exit(3);
  }
  if (jobSnap.size > 1) {
    console.error(`[polish-1.1] FAIL — ${target.id} has ${jobSnap.size} jobs (expected 1).`);
    process.exit(3);
  }
  const jobDoc = jobSnap.docs[0];
  const jobData = jobDoc.data() || {};
  console.log(`[polish-1.1] current job title: "${jobData.title}"`);

  const notesRef = db.doc(`incidents/${target.id}/notes/main`);
  const notesSnap = await notesRef.get();
  const notesData = notesSnap.exists ? notesSnap.data() || {} : null;
  console.log(`[polish-1.1] current incidentNotes (${(notesData?.incidentNotes || "").length} chars):`);
  console.log(`    ${(notesData?.incidentNotes || "(empty)").slice(0, 120)}…`);
  console.log(`[polish-1.1] current siteNotes (${(notesData?.siteNotes || "").length} chars):`);
  console.log(`    ${(notesData?.siteNotes || "(empty)")}`);

  console.log(`\n[polish-1.1] PLAN`);
  console.log(`  JOB    ${jobDoc.id}`);
  console.log(`         title: "${jobData.title}" → "${target.newJobTitle}"`);
  console.log(`  NOTES  notes/main`);
  console.log(`         incidentNotes: ${target.newIncidentNotes.length} chars`);
  console.log(`         siteNotes:     ${target.newSiteNotes.length} chars`);
  console.log(`         (photo + lifecycle timestamps + packetMeta untouched)`);

  if (!APPLY) {
    console.log(`\n[polish-1.1] DRY RUN — pass --apply to write.`);
    process.exit(0);
  }

  const batch = db.batch();
  batch.update(jobDoc.ref, {
    title: target.newJobTitle,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(
    notesRef,
    {
      incidentNotes: target.newIncidentNotes,
      siteNotes: target.newSiteNotes,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  try {
    await batch.commit();
  } catch (e) {
    console.error(`[polish-1.1] batch commit FAIL: ${e && e.message ? e.message : e}`);
    process.exit(5);
  }

  console.log(`\n[polish-1.1] write OK.`);
  console.log(`[polish-1.1] Verify in Chrome:`);
  console.log(
    `  https://app.peakops.app/incidents/${target.id}/summary?orgId=${target.org}`,
  );
  process.exit(0);
})().catch((e) => {
  console.error(`[polish-1.1] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
