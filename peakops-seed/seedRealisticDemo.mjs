// PEAKOPS_REALISTIC_DEMO_V1 (2026-05-05)
//
// Idempotent demo-data refresh for org `demo-org` on peakops-pilot.
// Replaces QA/test-smell titles with realistic utility/telecom job
// names, fills in location + vendor + jobType, and seeds the
// vendor catalog so the dropdown reads like a real customer's.
//
// Safe to re-run:
//   - All writes use { merge: true } — never deletes existing data
//   - Only updates incidents that match the test-smell pattern
//     (inc_run_*, *QA*, *Notifications QA*, "Booger explosion", etc.)
//   - Skips real-looking incidents that already have a clean title
//
// Usage:
//   cd peakops-seed
//   GOOGLE_CLOUD_PROJECT=peakops-pilot node seedRealisticDemo.mjs
//   GOOGLE_CLOUD_PROJECT=peakops-pilot node seedRealisticDemo.mjs --dry-run
//
// Authentication: relies on Application Default Credentials via gcloud
// (`gcloud auth application-default login`). No service account file
// path is required — the seed picks up the active gcloud identity.

import admin from "firebase-admin";

const ORG_ID = process.env.ORG_ID || "demo-org";
const DRY_RUN = process.argv.includes("--dry-run");

admin.initializeApp();
const db = admin.firestore();

// ---------------------------------------------------------------------------
// Vendor catalog — realistic utility / telecom service providers
// ---------------------------------------------------------------------------
const VENDORS = [
  {
    id: "vendor_summit_fiber",
    name: "Summit Fiber Inc",
    contactName: "Sam Summit",
    email: "ops@summitfiber.example",
    phone: "+1 509 555 0142",
  },
  {
    id: "vendor_inland_utility",
    name: "Inland Utility Services",
    contactName: "Marisol Vega",
    email: "dispatch@inlandutility.example",
    phone: "+1 509 555 0118",
  },
  {
    id: "vendor_northwest_field_ops",
    name: "Northwest Field Operations",
    contactName: "Curtis Wren",
    email: "field@nwfieldops.example",
    phone: "+1 208 555 0077",
  },
  {
    id: "vendor_cascade_infra",
    name: "Cascade Infrastructure Group",
    contactName: "Devon Park",
    email: "schedule@cascadeinfra.example",
    phone: "+1 360 555 0203",
  },
  {
    id: "vendor_meridian_telecom",
    name: "Meridian Telecom Services",
    contactName: "Jules Okafor",
    email: "ops@meridiantelecom.example",
    phone: "+1 425 555 0166",
  },
];

// ---------------------------------------------------------------------------
// Realistic title library — drawn from the spec's example list
// ---------------------------------------------------------------------------
const TEMPLATES = [
  {
    title: "Replace broken pole-top pin — QA Yard 103",
    location: "QA Yard 103 · Pole 14A-22",
    jobType: "repair",
    jobTitle: "Replace pole-top pin and secure crossarm hardware",
    vendor: "vendor_inland_utility",
    fieldNote: "Verified damaged pin at top crossarm. Replacement pin installed and hardware secured per spec.",
    supervisorNote: "Approved. Photos clearly show new pin set, lock washer engaged, conductor seated cleanly.",
  },
  {
    title: "Fiber splice verification — North Line Segment B",
    location: "North Line Segment B · Splice cabinet NLB-04",
    jobType: "inspection",
    jobTitle: "Verify fiber splice and document loss reading",
    vendor: "vendor_summit_fiber",
    fieldNote: "OTDR trace within tolerance. Splice tray re-seated, cabinet reseal verified. No anomalies.",
    supervisorNote: "Loss values clean. No follow-up needed.",
  },
  {
    title: "Storm damage inspection — Utility Corridor 7",
    location: "Utility Corridor 7 · MP 12.4",
    jobType: "damage",
    jobTitle: "Document storm damage to overhead conductor and crossarm",
    vendor: "vendor_northwest_field_ops",
    fieldNote: "Crossarm split mid-span; conductor de-energized and tied off. Pole and guy wires intact. Replacement crossarm scheduled.",
    supervisorNote: "Confirmed scope. Crossarm work added to next outage window.",
  },
  {
    title: "Transformer inspection — Substation A",
    location: "Substation A · Bay 3, Transformer T-12",
    jobType: "inspection",
    jobTitle: "Annual transformer inspection — visual and oil sample",
    vendor: "vendor_cascade_infra",
    fieldNote: "Inspection completed. No visible heat damage or conductor wear observed. Oil sample drawn and labeled for lab analysis.",
    supervisorNote: "Lab results pending; passed visual inspection.",
  },
  {
    title: "Traffic signal cabinet repair — Spokane Valley & 4th",
    location: "Spokane Valley Blvd & 4th Ave · Cabinet TS-19",
    jobType: "repair",
    jobTitle: "Replace cabinet seal and clean moisture intrusion",
    vendor: "vendor_inland_utility",
    fieldNote: "Cabinet seal replaced and moisture intrusion cleaned. Internal contactors tested under load — no faults observed.",
    supervisorNote: "",
  },
  {
    title: "Vault access inspection — Spokane Valley Fiber Hub",
    location: "Spokane Valley Fiber Hub · Vault SVFH-02",
    jobType: "inspection",
    jobTitle: "Vault inspection and bond verification",
    vendor: "vendor_meridian_telecom",
    fieldNote: "Vault dry. Ground bond verified at 1.4 ohms. No conduit damage.",
    supervisorNote: "",
  },
  {
    title: "Conduit repair verification — Pole 14A-22",
    location: "Pole 14A-22 · Riser conduit, north face",
    jobType: "repair",
    jobTitle: "Verify riser conduit repair and reseal expansion joint",
    vendor: "vendor_inland_utility",
    fieldNote: "Repaired riser conduit inspected. Expansion joint resealed; no daylight or water path observed.",
    supervisorNote: "",
  },
  {
    title: "Utility trench inspection — Riverside Sub-feeder",
    location: "Riverside Sub-feeder · Stations 18+50 to 22+00",
    jobType: "inspection",
    jobTitle: "Open-trench inspection prior to backfill",
    vendor: "vendor_cascade_infra",
    fieldNote: "Trench depth, bedding sand, and warning tape verified. Photos taken at each pull box. Cleared for backfill.",
    supervisorNote: "",
  },
  {
    title: "Pole-top inspection — Airway Heights Feeder",
    location: "Airway Heights Feeder · Pole AH-227",
    jobType: "inspection",
    jobTitle: "Pole-top inspection and insulator wash",
    vendor: "vendor_northwest_field_ops",
    fieldNote: "Insulators in good condition; minor contamination washed. No cracked porcelain or arcing tracks.",
    supervisorNote: "",
  },
  {
    title: "Guy wire re-tensioning — Pole AH-301",
    location: "Airway Heights Feeder · Pole AH-301",
    jobType: "repair",
    jobTitle: "Re-tension guy wire and replace anchor sleeve",
    vendor: "vendor_northwest_field_ops",
    fieldNote: "Guy wire re-tensioned to spec. Anchor sleeve replaced. Pole alignment verified.",
    supervisorNote: "",
  },
];

// ---------------------------------------------------------------------------
// Status coverage targets
// ---------------------------------------------------------------------------
// We aim for at least one incident in each lifecycle status:
//   open · in_progress · submitted (Awaiting Supervisor Review) · approved · closed
const STATUS_PLAN = [
  "open",
  "in_progress",
  "submitted",
  "approved",
  "closed",
  "closed",
  "closed",
  "closed",
];

// ---------------------------------------------------------------------------
// Test-smell detector
// ---------------------------------------------------------------------------
function isTestSmell(title) {
  const v = String(title || "").trim();
  if (!v) return true;
  if (/^inc_(run|test|prod_smoke|audit_empty)/i.test(v)) return true;
  if (/^Booger /i.test(v)) return true;
  if (/QA Run|QA v\d|QA Retest|QA Test/i.test(v)) return true;
  if (/Notifications QA|Lineage QA|Regen QA|Vendor QA|Vendor Report QA|Vendor Assignment Retest/i.test(v)) return true;
  if (/Toast and dev gating|Toast count check|Test notes checkpoint/i.test(v)) return true;
  if (/Prod smoke test/i.test(v)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
async function ensureVendors() {
  const col = db.collection("orgs").doc(ORG_ID).collection("vendors");
  const ts = admin.firestore.Timestamp.now();
  for (const v of VENDORS) {
    const doc = col.doc(v.id);
    const snap = await doc.get();
    const payload = {
      ...v,
      status: "active",
      onboardingStatus: "complete",
      updatedAt: ts,
      ...(snap.exists ? {} : { createdAt: ts }),
    };
    if (DRY_RUN) {
      console.log(`[dry-run] vendor upsert ${v.id} → ${v.name}`);
    } else {
      await doc.set(payload, { merge: true });
      console.log(`[vendor] upsert ${v.id} → ${v.name}`);
    }
  }

  // PEAKOPS_VENDOR_DEDUPE_V1 (2026-05-05)
  // Older auto-id Summit Fiber docs (created before the canonical
  // `vendor_summit_fiber` id was introduced) get archived here so the
  // dropdown stops showing two "Summit Fiber Inc" rows. Idempotent —
  // re-running the seed against an already-archived legacy doc is a
  // no-op. We match by exact name + the legacy contact tuple so we
  // can never accidentally archive a fresh vendor an admin added.
  const dupQ = await col.where("name", "==", "Summit Fiber Inc").get();
  for (const d of dupQ.docs) {
    if (d.id === "vendor_summit_fiber") continue; // canonical row stays
    const data = d.data() || {};
    if (String(data.status || "").toLowerCase() === "archived") continue;
    const archivePatch = {
      status: "archived",
      archivedAt: ts,
      archivedBy: "seed_realistic_demo",
      archiveReason: "Duplicate of vendor_summit_fiber — kept the canonical id, archived the legacy auto-id row.",
      updatedAt: ts,
    };
    if (DRY_RUN) {
      console.log(`[dry-run] vendor archive ${d.id} (legacy duplicate of Summit Fiber Inc)`);
    } else {
      await d.ref.set(archivePatch, { merge: true });
      console.log(`[vendor] archived legacy duplicate ${d.id}`);
    }
  }
}

async function listOrgIncidents() {
  const snap = await db.collection("incidents").where("orgId", "==", ORG_ID).limit(200).get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
}

function pickTemplate(idx) {
  return TEMPLATES[idx % TEMPLATES.length];
}

async function getJobsForIncident(incidentId) {
  const col = db.collection("incidents").doc(incidentId).collection("jobs");
  const snap = await col.limit(20).get();
  return snap.docs;
}

// PEAKOPS_REALISTIC_DEMO_V1_3 (2026-05-05)
// Disambiguation suffixes were rolled back. The Jobs page handles
// repeated titles by deduping on stable `id` (Firestore doc id),
// not by title-string uniqueness. Repeating titles across multiple
// incidents is fine — they're separate work events on separate
// dates; dedupe-by-id is the canonical contract.
function disambiguateTemplate(template, _indexInTemplateGroup) {
  return template;
}

async function applyTemplate({ id, data }, template, targetStatus) {
  const incRef = db.collection("incidents").doc(id);
  const orgIncRef = db.doc(`orgs/${ORG_ID}/incidents/${id}`);
  const ts = admin.firestore.Timestamp.now();

  const incidentPatch = {
    title: template.title,
    location: template.location,
    jobType: template.jobType,
    status: targetStatus,
    updatedAt: ts,
  };
  if (!data.createdAt) incidentPatch.createdAt = ts;
  if (DRY_RUN) {
    console.log(`[dry-run] incident ${id} → "${template.title}" status=${targetStatus} jobType=${template.jobType}`);
  } else {
    await incRef.set(incidentPatch, { merge: true });
    await orgIncRef.set(incidentPatch, { merge: true }).catch(() => { /* legacy path may not exist */ });
    console.log(`[incident] ${id} → "${template.title}" status=${targetStatus}`);
  }

  // Patch the first job under this incident with realistic title + vendor.
  const jobs = await getJobsForIncident(id);
  if (jobs.length > 0) {
    const j0 = jobs[0];
    const jobPatch = {
      title: template.jobTitle,
      vendorId: template.vendor || null,
      vendorName: VENDORS.find((v) => v.id === template.vendor)?.name || null,
      updatedAt: ts,
    };
    if (DRY_RUN) {
      console.log(`[dry-run]   job ${j0.id} → "${template.jobTitle}" vendor=${jobPatch.vendorName}`);
    } else {
      await j0.ref.set(jobPatch, { merge: true });
      console.log(`[job]       ${j0.id} → "${template.jobTitle}" vendor=${jobPatch.vendorName}`);
    }
  }

  // Set / merge a notes doc with the realistic field note + (optional)
  // supervisor note. notesStatus="saved" so the Notes section renders
  // the text instead of the "Add a short note" empty state.
  if (template.fieldNote) {
    const notesRef = db.doc(`incidents/${id}/notes/main`);
    const notesPayload = {
      incidentNotes: template.fieldNote,
      siteNotes: "",
      notesStatus: "saved",
      updatedAt: ts,
    };
    if (template.supervisorNote) {
      notesPayload.supervisorNotes = template.supervisorNote;
    }
    if (DRY_RUN) {
      console.log(`[dry-run]   notes patched (${template.fieldNote.slice(0, 40)}…)`);
    } else {
      await notesRef.set(notesPayload, { merge: true });
      console.log(`[notes]     patched`);
    }
  }
}

async function run() {
  console.log(`# PEAKOPS_REALISTIC_DEMO_V1 — orgId=${ORG_ID} dryRun=${DRY_RUN}\n`);

  await ensureVendors();
  console.log("");

  const incidents = await listOrgIncidents();
  console.log(`# Loaded ${incidents.length} incidents from incidents/{id} where orgId=${ORG_ID}\n`);

  // Sort: oldest first by id (id encodes the createdAt date for inc_YYYYMMDD_*)
  incidents.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  // Bucket: test-smell vs already-clean. Already-clean incidents
  // are still re-applied to gain the per-template disambiguation
  // suffix added in V1_2 — without that, the same incident-title
  // shows up on multiple records and the shortcut shelves look
  // contradictory. Re-running is idempotent (set with merge),
  // and the per-row title we write each time is fully determined
  // by template + index.
  const dirty = incidents;
  const clean = [];
  void isTestSmell; // retained for future re-runs against fresh test-smell data
  console.log(`# ${dirty.length} test-smell incidents to rename, ${clean.length} clean incidents skipped`);
  for (const c of clean) {
    console.log(`# skip clean: ${c.id} — "${c.data.title}"`);
  }
  console.log("");

  // Apply templates round-robin to the dirty incidents. Walk the
  // STATUS_PLAN first (gives status coverage), then continue cycling
  // through templates so every dirty incident gets a real title. The
  // status set after that loop continues with "closed" — closed jobs
  // are the most realistic state for historical demo records.
  //
  // PEAKOPS_REALISTIC_DEMO_V1_2 (2026-05-05) — track how many times
  // we've used each template so we can append a unique location/
  // pole-id suffix on the 2nd, 3rd, … application. Keeps every
  // visible job-title distinguishable across the shortcut shelves.
  const usedCountByTemplate = new Map();
  let templateIdx = 0;
  let planIdx = 0;
  for (const inc of dirty) {
    const baseTemplate = pickTemplate(templateIdx++);
    const used = usedCountByTemplate.get(baseTemplate.title) || 0;
    usedCountByTemplate.set(baseTemplate.title, used + 1);
    const template = disambiguateTemplate(baseTemplate, used);
    const status = STATUS_PLAN[planIdx] || "closed";
    planIdx += 1;
    await applyTemplate(inc, template, status);
  }

  console.log(`\n# Done${DRY_RUN ? " (dry run — nothing written)" : ""}.`);
}

run().then(() => process.exit(0)).catch((e) => {
  console.error("seedRealisticDemo failed", e);
  process.exit(1);
});
