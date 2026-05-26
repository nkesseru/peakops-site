/**
 * PEAKOPS_SEED_TELECOM_DEMO_V1 (PR 86)
 *
 * Idempotent Firestore seed for the Telecom Mode demo org
 * (Northwind Fiber Services) on peakops-pilot. Run manually
 * when you want to populate the demo flow; safe to re-run
 * (uses set + merge).
 *
 * Usage:
 *   node scripts/seedTelecomDemo.cjs
 *
 * What it does:
 *   1. Creates the org `northwind-fiber-services` (if not present)
 *   2. Adds the smoke user (smoke-pr72-uid) as a supervisor on
 *      the org so testing can drive the flow
 *   3. Writes 5 demo work-package incidents with realistic
 *      telecom statuses, titles, customer, and notes
 *
 * Cleanup:
 *   Each demo incident's title is prefixed with "NWF-DEMO" so
 *   you can spot + delete them in the Firebase console if you
 *   ever want to clear them.
 *
 * What it does NOT do:
 *   - It does NOT deploy any code (no firebase deploy)
 *   - It does NOT modify the ARCHETYPE_ENUM or any function
 *   - It does NOT touch other orgs or other users
 */

const fs = require("fs");
const path = require("path");
const admin = require(
  path.join(__dirname, "..", "node_modules", "firebase-admin"),
);

const SERVICE_ACCOUNT = path.join(
  __dirname,
  "..",
  "next-app",
  "service-account.json",
);

const ORG_ID = "northwind-fiber-services";
const ORG_DISPLAY_NAME = "Northwind Fiber Services";
const CUSTOMER = "Cascade Broadband Infrastructure";
const PROGRAM = "Rural Fiber Expansion — Phase 2";
const MARKET = "Spokane Valley / Liberty Lake Expansion";

const SUPERVISOR_UID = "smoke-pr72-uid";

const DEMO_INCIDENTS = [
  {
    incidentId: "nwf_demo_fiber_splice_pending_review",
    title: "NWF-DEMO · Fiber Splice Verification — Awaiting Acceptance Review",
    archetype: "fiber_splice_verification",
    status: "in_progress",
    location: "Vault SPK-VLY-014, Liberty Lake corridor",
    priority: "normal",
    notes:
      "Splice tray photo captured. Vault label verified. Redline/as-built attached for PM review.",
  },
  {
    incidentId: "nwf_demo_restoration_accepted",
    title: "NWF-DEMO · Restoration Completion — Accepted",
    archetype: "storm_restoration_proof",
    status: "closed",
    location: "E Sprague Ave, Spokane Valley",
    priority: "normal",
    notes:
      "Restoration photos complete. Site safe verified. Permit closed.",
  },
  {
    incidentId: "nwf_demo_drop_install_missing_proof",
    title: "NWF-DEMO · Drop Installation Completion — Missing Required Proof",
    archetype: "custom",
    status: "draft",
    location: "1847 Spokane St, Liberty Lake",
    priority: "high",
    notes:
      "Missing customer premises exterior photo. Pedestal + terminal photos captured.",
  },
  {
    incidentId: "nwf_demo_punch_list_qa",
    title: "NWF-DEMO · Punch-List Resolution — QA Review Needed",
    archetype: "custom",
    status: "in_progress",
    location: "Vault SPK-VLY-022",
    priority: "normal",
    notes:
      "Corrective action photos uploaded. QA reviewer requested one additional context photo.",
  },
  {
    incidentId: "nwf_demo_segment_closeout_export_ready",
    title: "NWF-DEMO · Segment Closeout Packet — Ready for Export",
    archetype: "fiber_splice_verification",
    status: "closed",
    location: "Liberty Lake segment 14B",
    priority: "normal",
    notes:
      "Packet ready for customer acceptance review. All proof items present, QA signoff complete.",
  },
];

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(fs.readFileSync(SERVICE_ACCOUNT, "utf8")),
      ),
    });
  }
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  console.log(`[seed] target org: ${ORG_ID}`);

  // 1. Org doc
  await db.doc(`orgs/${ORG_ID}`).set(
    {
      orgId: ORG_ID,
      name: ORG_DISPLAY_NAME,
      industry: "telecom",
      customer: CUSTOMER,
      program: PROGRAM,
      market: MARKET,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  console.log(`[seed] org doc upserted`);

  // 2. Supervisor membership
  await db.doc(`orgs/${ORG_ID}/members/${SUPERVISOR_UID}`).set(
    {
      uid: SUPERVISOR_UID,
      role: "supervisor",
      status: "active",
      addedBy: "seedTelecomDemo",
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  console.log(`[seed] supervisor membership upserted for ${SUPERVISOR_UID}`);

  // 3. Demo incidents
  for (const inc of DEMO_INCIDENTS) {
    const doc = {
      orgId: ORG_ID,
      incidentId: inc.incidentId,
      title: inc.title,
      status: inc.status,
      archetype: inc.archetype,
      location: inc.location,
      priority: inc.priority,
      notes: inc.notes,
      customer: CUSTOMER,
      filingTypesRequired: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    // Dual-write to mirror createIncidentV1's behaviour
    await db.doc(`incidents/${inc.incidentId}`).set(doc, { merge: true });
    await db
      .doc(`orgs/${ORG_ID}/incidents/${inc.incidentId}`)
      .set(doc, { merge: true });
    console.log(`[seed] incident upserted: ${inc.incidentId}`);
  }

  console.log(`\n[seed] done — ${DEMO_INCIDENTS.length} demo incidents ready`);
  console.log(`[seed] add a user as supervisor by uid via Admin SDK if needed.`);
  console.log(`[seed] /records will show these for the supervisor uid above.`);
}

main().catch((e) => {
  console.error("[seed] failed:", e?.stack || e);
  process.exit(1);
});
