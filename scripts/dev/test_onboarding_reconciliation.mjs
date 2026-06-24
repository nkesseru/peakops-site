#!/usr/bin/env node
// PR 134A.2 — static drift guard for /onboarding wizard reconciliation.
//
// Catches the most common regressions:
//   1. /api/onboarding-status drops the scriptActivated derivation
//   2. /api/onboarding-status drops bootstrappedBy / bootstrappedAt
//      from its response payload (OnboardingActivatedNotice depends on
//      both)
//   3. OnboardingClient stops gating on activationCheck.data.scriptActivated
//      before rendering the wizard (would re-introduce the overwrite
//      risk patchOrgFromOnboarding poses against CS-set values)
//   4. OnboardingActivatedNotice loses its escape-hatch button (the
//      legacy path that lets an operator opt back into the wizard
//      must remain reachable)
//   5. Activation detection AND-condition loosens to a simple "exists"
//      check (would fire for hand-bootstrapped orgs and skip the
//      wizard for users who actually need it)

import fs from "node:fs";

const ROOT = "/Users/kesserumini/peakops/my-app";

let failed = 0;
function ok(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}${detail ? ` (${detail})` : ""}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function read(p) { return fs.readFileSync(p, "utf8"); }

console.log("══ /onboarding wizard reconciliation drift guard ═════════════════════");

// ── 1. /api/onboarding-status payload contract ────────────────────
const apiSource = read(`${ROOT}/next-app/app/api/onboarding-status/route.ts`);
ok("API route exports bootstrappedBy in response", /bootstrappedBy(?:[\s:,])/.test(apiSource));
ok("API route exports bootstrappedAt in response", /bootstrappedAt(?:[\s:,])/.test(apiSource));
ok("API route exports scriptActivated in response", /scriptActivated(?:[\s:,])/.test(apiSource));
ok("API route derives scriptActivated from conjunction (bootstrappedBy AND templates AND kind)",
   /scriptActivated\s*=\s*Boolean\(\s*\n?\s*bootstrappedBy\s*&&\s*templates\.length\s*>\s*0\s*&&\s*org\.kind\s*===\s*"customer"/.test(apiSource));

// ── 2. OnboardingActivatedNotice contract ─────────────────────────
const noticeSource = read(`${ROOT}/next-app/components/OnboardingActivatedNotice.tsx`);
ok("OnboardingActivatedNotice exported", /export function OnboardingActivatedNotice/.test(noticeSource));
ok("OnboardingActivatedNotice surfaces orgName", /\{orgName\}/.test(noticeSource));
ok("OnboardingActivatedNotice surfaces starterTemplate", /starterTemplate/.test(noticeSource));
ok("OnboardingActivatedNotice has Go to dashboard CTA",
   /href="\/dashboard"/.test(noticeSource));
ok("OnboardingActivatedNotice has escape hatch (onForceWizard)",
   /onForceWizard\(\)/.test(noticeSource) || /onClick=\{onForceWizard\}/.test(noticeSource));
ok("OnboardingActivatedNotice escape hatch is low-contrast (text-gray-* not bg-white)",
   /onboarding-activated-force[^]*?className="[^"]*text-gray-/.test(noticeSource));

// ── 3. OnboardingClient gates wizard render on activation check ──
const wizSource = read(`${ROOT}/next-app/app/onboarding/OnboardingClient.tsx`);
ok("OnboardingClient imports OnboardingActivatedNotice",
   /import \{ OnboardingActivatedNotice \} from "@\/components\/OnboardingActivatedNotice"/.test(wizSource));
ok("OnboardingClient holds activationCheck state",
   /\[activationCheck,\s*setActivationCheck\]\s*=\s*useState/.test(wizSource));
ok("OnboardingClient holds forceWizard escape-hatch state",
   /const \[forceWizard, setForceWizard\] = useState/.test(wizSource));
ok("OnboardingClient fetches /api/onboarding-status",
   /authedFetch\(`\/api\/onboarding-status\?orgId=/.test(wizSource));
ok("OnboardingClient renders OnboardingActivatedNotice when scriptActivated && !forceWizard",
   /activationCheck\.data\?\.scriptActivated\s*&&\s*!forceWizard[\s\S]{0,200}<OnboardingActivatedNotice/.test(wizSource));
ok("OnboardingClient bails out before wizard render when activation still loading",
   /activationCheck\.loading[\s\S]{0,300}return/.test(wizSource));

// ── 4. createOrgV1 still stamps bootstrappedBy ────────────────────
// The activation detection collapses to "exists" if createOrgV1
// stops writing this field; lock it in here.
const createOrgSource = read(`${ROOT}/functions_clean/createOrgV1.js`);
ok("createOrgV1 still stamps bootstrappedBy on the org doc",
   /bootstrappedBy:\s*callerUid/.test(createOrgSource));
ok("createOrgV1 still stamps bootstrappedAt on the org doc",
   /bootstrappedAt:\s*now/.test(createOrgSource));

console.log("\n" + "═".repeat(70));
if (failed === 0) {
  console.log("🟢 PR 134A.2 onboarding-reconciliation drift guard — all assertions pass");
  process.exit(0);
} else {
  console.log(`🔴 ${failed} assertion(s) failed — onboarding reconciliation surface drifted from PR 134A.2 contract`);
  process.exit(1);
}
