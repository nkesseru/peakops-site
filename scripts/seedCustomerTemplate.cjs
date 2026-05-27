/**
 * PEAKOPS_SEED_CUSTOMER_TEMPLATE_V1 (PR 91)
 *
 * Idempotent Firestore seed for the PR 91 Customer Template Layer
 * on peakops-pilot. Run manually when you want to exercise the
 * customer-template / org-template resolution paths; safe to
 * re-run (uses set + merge).
 *
 * Usage:
 *   node scripts/seedCustomerTemplate.cjs
 *
 * What it does:
 *   Writes 2 demo templates to peakops-internal-alpha:
 *
 *   1. ORG-WIDE template for `fiber_splice_verification`
 *      Doc path: orgs/peakops-internal-alpha/templates/fiber_splice_verification
 *      Applies to ANY record of this archetype in this org
 *      regardless of customer field.
 *      Demonstrates source: "org_template" snapshot.
 *
 *   2. CUSTOMER-SPECIFIC template for the same archetype
 *      Customer: "Cascade Broadband Infrastructure"
 *      Doc path: orgs/peakops-internal-alpha/templates/
 *                  fiber_splice_verification__cascade-broadband-infrastructure
 *      Wins over the org-wide default when the record's customer
 *      string slugifies to the same key.
 *      Demonstrates source: "customer_template" snapshot.
 *
 * Cleanup:
 *   Each template is tagged label: "PR91-SEED · ..." so you can
 *   spot + delete in the Firebase console. Re-runs are no-ops
 *   (set + merge preserves version + audit fields).
 *
 * What it does NOT do:
 *   - It does NOT deploy any code (no firebase deploy)
 *   - It does NOT modify createIncidentV1 or any function
 *   - It does NOT touch other orgs / users / records
 *   - It does NOT create a customer entity (none exists by design)
 *
 * After seeding, exercise the path:
 *   1. Create a record with customer "Cascade Broadband Infrastructure"
 *      and archetype "fiber_splice_verification" → snapshot has
 *      source: "customer_template", templateKey: "fiber_splice_verification__cascade-broadband-infrastructure"
 *   2. Create a record with a different customer + same archetype →
 *      snapshot has source: "org_template", templateKey: "fiber_splice_verification"
 *   3. Create a record with a different archetype → snapshot has
 *      source: "archetype" (code catalog, unchanged).
 */

const fs = require("fs");
const path = require("path");
const admin = require(
  path.join(__dirname, "..", "node_modules", "firebase-admin"),
);
const { toCustomerSlug } = require(
  path.join(__dirname, "..", "functions_clean", "_customerSlug"),
);

const SERVICE_ACCOUNT = path.join(
  __dirname, "..", "next-app", "service-account.json",
);

const ORG_ID = "peakops-internal-alpha";

// Org-wide default for fiber splice verification. Applies when no
// customer-specific template matches.
const ORG_TEMPLATE = {
  docId: "fiber_splice_verification",
  data: {
    archetype: "fiber_splice_verification",
    label: "PR91-SEED · Fiber splice verification (org default)",
    requiredProof: [
      "Completion photos",
      "GPS capture",
      "Supervisor approval",
      "Splice loss reading",
    ],
    optionalProof: ["OTDR trace screenshot"],
    acceptanceCriteria: [
      "Required photos uploaded",
      "Supervisor signoff present",
      "Loss reading captured",
    ],
    version: 1,
    updatedBy: "seedCustomerTemplate",
  },
};

// Customer-specific template. Wins over the org-wide default
// when an incident's customer field slugifies to the same key.
const CUSTOMER_NAME = "Cascade Broadband Infrastructure";
const CUSTOMER_SLUG = toCustomerSlug(CUSTOMER_NAME);
const CUSTOMER_TEMPLATE = {
  docId: `fiber_splice_verification__${CUSTOMER_SLUG}`,
  data: {
    archetype: "fiber_splice_verification",
    customerMatch: { mode: "exact", value: CUSTOMER_NAME },
    label: `PR91-SEED · Fiber splice verification — ${CUSTOMER_NAME}`,
    requiredProof: [
      "Splice enclosure photo",
      "Splice tray photo",
      "Fiber labeling / tag photo",
      "Vault or handhole context photo",
      "Redline / as-built attachment",
      "Technician completion note",
      "QA reviewer signoff",
    ],
    optionalProof: ["OTDR trace screenshot", "Splice loss reading"],
    acceptanceCriteria: [
      "Required photos uploaded",
      "Completion note present",
      "QA signoff present",
      "Packet ready for customer acceptance review",
    ],
    version: 1,
    updatedBy: "seedCustomerTemplate",
  },
};

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
  console.log(`[seed] customer slug: "${CUSTOMER_NAME}" → "${CUSTOMER_SLUG}"`);

  for (const tpl of [ORG_TEMPLATE, CUSTOMER_TEMPLATE]) {
    const ref = db.doc(`orgs/${ORG_ID}/templates/${tpl.docId}`);
    await ref.set(
      {
        ...tpl.data,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    console.log(`[seed] upserted templates/${tpl.docId} (v${tpl.data.version})`);
  }

  console.log(`\n[seed] done — 2 templates ready in orgs/${ORG_ID}/templates/`);
  console.log("[seed] Exercise via:");
  console.log("  - Create record archetype=fiber_splice_verification customer=\"Cascade Broadband Infrastructure\"");
  console.log("       → source: customer_template");
  console.log("  - Create record archetype=fiber_splice_verification customer=anything-else");
  console.log("       → source: org_template");
  console.log("  - Create record archetype=pole_inspection");
  console.log("       → source: archetype (no template defined for that archetype)");
}

main().catch((e) => {
  console.error("[seed] failed:", e?.stack || e);
  process.exit(1);
});
