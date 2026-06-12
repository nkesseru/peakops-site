// PEAKOPS_DEMO_ROLE_MEMBERS_SEED_V1 (2026-05-06)
//
// Phase 1 Slice 4.1 live-role smoke companion to seedDemoMembership.ts.
// The original seed lays down `dev-admin` and `tech_web` both as
// role="admin" — fine for membership-only smoke, but Slice 4 needs
// one member of every role to exercise the role allow-lists.
//
// This script seeds (in addition to the originals):
//   orgs/demo-org/members/supe_smoke   role=supervisor  status=active
//   orgs/demo-org/members/field_smoke  role=field       status=active
//   orgs/demo-org/members/viewer_smoke role=viewer      status=active
//
// Same safety rails as the parent seed:
//   - Demo-org-only. Refuses any other orgId.
//   - Refuses to run unless GCLOUD_PROJECT / FIREBASE_PROJECT_ID
//     contains "demo"/"emu"/"staging", or --allow-prod is passed.
//   - Dry-run by default. --apply to write.
//   - Idempotent: existing member docs are merged, not replaced.
//
// Run from next-app/:
//   npx tsx scripts/seedDemoRoleMembers.ts                # dry-run
//   npx tsx scripts/seedDemoRoleMembers.ts --apply        # write

import {
  applicationDefault,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

import { isDemoOrg } from "../src/lib/orgKind";

const APPLY = process.argv.includes("--apply");
const ALLOW_PROD = process.argv.includes("--allow-prod");

const DEMO_ORG_ID = "demo-org";

type RoleSeed = {
  uid: string;
  role: "admin" | "supervisor" | "field" | "viewer";
};

const ROLE_MEMBERS: ReadonlyArray<RoleSeed> = [
  { uid: "supe_smoke", role: "supervisor" },
  { uid: "field_smoke", role: "field" },
  { uid: "viewer_smoke", role: "viewer" },
];

function ensureAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!;
  // PEAKOPS_SEED_PROJECT_DEFAULT_V1 (2026-05-06)
  // Default GCLOUD_PROJECT to peakops-demo when running against the
  // local emulator without a project explicitly set. Without this,
  // firebase-admin auto-detects a different namespace and writes
  // silently land in the wrong project. Caller's GCLOUD_PROJECT
  // wins if already set.
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

function projectLooksDemo(): boolean {
  // PEAKOPS_SLICE11_EMULATOR_AUTODETECT_V1 (2026-05-06)
  // Mirror of the auto-detect guard in seedDemoMembership.ts. Any
  // *_EMULATOR_HOST env var being set is proof that we're in
  // emulator mode; production firebase-admin never carries those.
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

async function main(): Promise<void> {
  if (!isDemoOrg(DEMO_ORG_ID)) {
    console.error(
      `[seed] FATAL: ${DEMO_ORG_ID} is not classified as a demo org. Refusing.`,
    );
    process.exit(2);
  }
  if (!ALLOW_PROD && !projectLooksDemo()) {
    console.error(
      "[seed] FATAL: project does not look like demo/emulator/staging. " +
        "Pass --allow-prod to override.",
    );
    process.exit(2);
  }

  ensureAdminApp();
  const db = getFirestore();

  console.log(
    `[seed] mode=${APPLY ? "APPLY" : "dry-run"} org=${DEMO_ORG_ID} ` +
      `roles=${ROLE_MEMBERS.map((r) => `${r.uid}/${r.role}`).join(",")}`,
  );

  let written = 0;
  let already = 0;

  for (const m of ROLE_MEMBERS) {
    const ref = db.doc(`orgs/${DEMO_ORG_ID}/members/${m.uid}`);
    const snap = await ref.get();
    if (snap.exists) {
      const cur = snap.data() || {};
      if (
        String(cur.role || "").toLowerCase() === m.role &&
        String(cur.status || "").toLowerCase() === "active"
      ) {
        console.log(`  ✓ members/${m.uid} already ${m.role}/active`);
        already += 1;
        continue;
      }
      console.log(
        `  → members/${m.uid} patch role="${m.role}" status="active" ` +
          `(was role="${cur.role}" status="${cur.status}")`,
      );
    } else {
      console.log(`  → members/${m.uid} create role="${m.role}" status="active"`);
    }
    if (APPLY) {
      await ref.set(
        {
          uid: m.uid,
          role: m.role,
          status: "active",
          source: "demo-role-seed",
          createdAt: snap.exists ? undefined : FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    written += 1;
  }

  console.log(
    `[seed] ${APPLY ? "wrote" : "would write"} ${written} member doc(s); ${already} already correct.`,
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
