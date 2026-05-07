// PEAKOPS_BACKFILL_ORG_FIELDS_V1 (2026-05-06)
//
// One-off backfill that ensures every doc under `orgs/` has its `kind`
// field set, anchoring the demo↔customer separation invariant from
// docs/MULTI_ORG_RELATIONSHIP_MODEL.md before Phase 1 is closed.
//
// Default mode is dry-run. Pass --apply to actually write. Pass --force
// alongside --apply to also overwrite docs whose kind is already set
// (use sparingly — overwriting an existing kind is the kind of action
// that should be deliberate and audit-logged later).
//
// Run from the next-app/ directory:
//   npx tsx scripts/backfillOrgFields.ts                     # dry-run
//   npx tsx scripts/backfillOrgFields.ts --apply             # write missing kind only
//   npx tsx scripts/backfillOrgFields.ts --apply --force     # overwrite existing kind too
//
// Credentials: relies on firebase-admin's applicationDefault(), so set
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
// before invoking.
//
// Plan:
//   - "demo-org" (and any other id in PROTECTED_DEMO_ORG_IDS) → "demo"
//   - everything else with no kind                            → "customer"
//   - everything else with kind already set                   → skipped
//                                                              (unless --force)

import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { isDemoOrg } from "../src/lib/orgKind";

type PlanRow = {
  orgId: string;
  currentKind: string;
  targetKind: "demo" | "customer";
  action: "set" | "skip-already-correct" | "skip-existing" | "overwrite";
};

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

function ensureAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!;
  return initializeApp({ credential: applicationDefault() });
}

function planFor(orgId: string, currentKind: string): PlanRow {
  const target: PlanRow["targetKind"] = isDemoOrg(orgId) ? "demo" : "customer";
  if (currentKind === target) {
    return { orgId, currentKind, targetKind: target, action: "skip-already-correct" };
  }
  if (currentKind && !FORCE) {
    return { orgId, currentKind, targetKind: target, action: "skip-existing" };
  }
  if (currentKind && FORCE) {
    return { orgId, currentKind, targetKind: target, action: "overwrite" };
  }
  return { orgId, currentKind, targetKind: target, action: "set" };
}

function formatRow(row: PlanRow): string {
  switch (row.action) {
    case "skip-already-correct":
      return `  ✓  ${row.orgId} already kind="${row.targetKind}"`;
    case "skip-existing":
      return `  ⏭  ${row.orgId} has kind="${row.currentKind}" — pass --force to overwrite to "${row.targetKind}"`;
    case "overwrite":
      return `  !  ${row.orgId} OVERWRITE "${row.currentKind}" → "${row.targetKind}"`;
    case "set":
      return `  →  ${row.orgId} SET kind="${row.targetKind}"`;
  }
}

async function main(): Promise<void> {
  ensureAdminApp();
  const db = getFirestore();

  console.log(
    `[backfill] mode=${APPLY ? "APPLY" : "dry-run"} force=${FORCE ? "yes" : "no"}`,
  );

  const snap = await db.collection("orgs").get();
  console.log(`[backfill] scanning ${snap.size} org doc(s)`);

  const rows: PlanRow[] = [];
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const currentKind =
      typeof data.kind === "string" ? data.kind.trim().toLowerCase() : "";
    rows.push(planFor(docSnap.id, currentKind));
  }

  for (const row of rows) {
    console.log(formatRow(row));
  }

  const writable = rows.filter(
    (r) => r.action === "set" || r.action === "overwrite",
  );
  const skipped = rows.length - writable.length;

  console.log(
    `[backfill] planned writes: ${writable.length}, skipped: ${skipped}`,
  );

  if (!APPLY) {
    console.log("[backfill] dry-run only. Pass --apply to write.");
    return;
  }

  if (writable.length === 0) {
    console.log("[backfill] nothing to write.");
    return;
  }

  let written = 0;
  for (const row of writable) {
    await db
      .doc(`orgs/${row.orgId}`)
      .set({ kind: row.targetKind }, { merge: true });
    written += 1;
  }
  console.log(`[backfill] wrote ${written} doc(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });
