// PEAKOPS_DEMO_MEMBERSHIP_SEED_V1 (2026-05-06)
//
// Phase 1 Slice 2 of MULTI_ORG_IMPLEMENTATION_PLAN.md retrofitted
// closeIncidentV1 / addEvidenceV1 / assignJobOrgV1 with the shared
// authz gate (orgs/{orgId}/members/{uid} required). The smoke /
// demo flow uses body-supplied uids like "dev-admin" and "tech_web"
// which had no member doc in `demo-org` before this slice. Without
// seeded memberships those callables now fail closed (correctly).
//
// This script lays down member docs for the canonical dev uids, and
// pins the demo-org doc to kind="demo" so the demo↔customer barrier
// holds even before the backfill runs in production.
//
// Safety:
//   - Demo-org-only. The script refuses to write to any other orgId.
//   - Dry-run by default. --apply to write.
//   - Idempotent: existing member docs are merged, never replaced.
//   - Production-aware: if --allow-prod is NOT passed, the script
//     refuses to run when GCLOUD_PROJECT / FIREBASE_PROJECT_ID does
//     not contain "demo" or "emu". Production env still needs an
//     explicit opt-in flag.
//
// Run from next-app/:
//   npx tsx scripts/seedDemoMembership.ts                 # dry-run
//   npx tsx scripts/seedDemoMembership.ts --apply         # write
//   npx tsx scripts/seedDemoMembership.ts --apply \
//     --uids=dev-admin,tech_web,my_test_uid               # custom list
//
// The demo seed is paired with backfillOrgFields.ts: the latter
// pins kind globally; this one ensures the dev uids have membership
// in the protected demo tenant. Both are dry-run by default.

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

const DEFAULT_DEMO_UIDS = ["dev-admin", "tech_web"] as const;

function parseUidsArg(): string[] {
  const flag = process.argv.find((a) => a.startsWith("--uids="));
  if (!flag) return [...DEFAULT_DEMO_UIDS];
  const list = flag
    .slice("--uids=".length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_DEMO_UIDS];
}

const DEMO_ORG_ID = "demo-org";

function ensureAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!;
  // PEAKOPS_SEED_PROJECT_DEFAULT_V1 (2026-05-06)
  // Default GCLOUD_PROJECT to peakops-demo when running against a
  // local emulator without a project explicitly set. Without this,
  // firebase-admin auto-detects a different namespace and writes
  // land in the wrong project. See lifecycle-seed for the full
  // explanation.
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
  // Any of the *_EMULATOR_HOST env vars is a strong, local-only
  // signal that this Node process is talking to the local emulator
  // suite rather than real Firebase. Production firebase-admin
  // never carries those vars. Treating them as proof of "demo
  // environment" lets a teammate run `FIRESTORE_EMULATOR_HOST=...
  // npx tsx scripts/seedDemoMembership.ts --apply` without also
  // having to remember to set GCLOUD_PROJECT to a demo-shaped name
  // — the most common Slice 10.1 onboarding paper-cut.
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
      `[seed] FATAL: ${DEMO_ORG_ID} is not classified as a demo org. ` +
        `Refusing to seed.`,
    );
    process.exit(2);
  }

  if (!ALLOW_PROD && !projectLooksDemo()) {
    console.error(
      "[seed] FATAL: project does not look like a demo/emulator/staging " +
        "environment. Pass --allow-prod to override (you almost never want " +
        "to do this).",
    );
    process.exit(2);
  }

  ensureAdminApp();
  const db = getFirestore();
  const uids = parseUidsArg();

  console.log(
    `[seed] mode=${APPLY ? "APPLY" : "dry-run"} org=${DEMO_ORG_ID} uids=${uids.join(",")}`,
  );

  // 1) Pin demo-org doc to kind="demo" (idempotent).
  const orgRef = db.doc(`orgs/${DEMO_ORG_ID}`);
  const orgSnap = await orgRef.get();
  const orgKind = String((orgSnap.data() || {}).kind || "").toLowerCase();
  if (orgKind === "demo") {
    console.log(`  ✓ orgs/${DEMO_ORG_ID} already kind="demo"`);
  } else {
    console.log(
      `  → orgs/${DEMO_ORG_ID} ${orgSnap.exists ? "patch" : "create"} kind="demo"`,
    );
    if (APPLY) {
      await orgRef.set(
        {
          kind: "demo",
          name: orgSnap.exists ? undefined : "Demo Org",
          status: "active",
          bootstrappedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  }

  // 2) Lay down member docs for each dev uid.
  let created = 0;
  let already = 0;
  for (const uid of uids) {
    const memberRef = db.doc(`orgs/${DEMO_ORG_ID}/members/${uid}`);
    const memberSnap = await memberRef.get();
    if (memberSnap.exists) {
      const m = memberSnap.data() || {};
      const status = String(m.status || "").toLowerCase();
      const role = String(m.role || "").toLowerCase();
      if (status === "active" && role) {
        console.log(`  ✓ members/${uid} already active (role=${role})`);
        already += 1;
        continue;
      }
      console.log(
        `  → members/${uid} patch status="active" role="admin" (was status="${status}" role="${role}")`,
      );
    } else {
      console.log(`  → members/${uid} create role="admin" status="active"`);
    }
    if (APPLY) {
      await memberRef.set(
        {
          uid,
          role: "admin",
          status: "active",
          source: "demo-seed",
          createdAt: memberSnap.exists ? undefined : FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
    created += 1;
  }

  console.log(
    `[seed] ${APPLY ? "wrote" : "would write"} ${created} member doc(s); ${already} already active.`,
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
