/**
 * PEAKOPS_ORG_INDUSTRY_V1 (PR 86)
 *
 * Industry detection for an org. PeakOps's first specialized
 * industry mode is "telecom" (fiber / broadband closeout
 * workflows). The default mode is "default" — the generic
 * proof/acceptance vocabulary established through PR 71/82/84/85.
 *
 * Architecture (foundation pass):
 *   - This module is a STATIC allowlist of orgIds keyed to
 *     "telecom" mode. No backend dependency, no Firestore read.
 *   - A future PR migrates this to a per-org Firestore field
 *     (something like orgs/{orgId}.industry = "telecom") and
 *     deprecates the allowlist. Until then, listing an orgId
 *     here is how an org opts into telecom mode.
 *   - Why static for now: zero backend risk, instant deploy,
 *     easy to A/B per demo, and the surface area is small (1
 *     known telecom org as of PR 86).
 *
 * Adding an org to telecom mode:
 *   1. Add the orgId string to TELECOM_ORGS below
 *   2. (Optional) Run scripts/seedTelecomDemo.cjs to populate
 *      demo work packages for that org
 *
 * Why this lives in lib/industries/ and not in lib/incidents/:
 *   Industry framing is a cross-cutting concern that may
 *   eventually touch Records, Dashboard, Review, Summary, etc.
 *   Keeping it in its own folder makes the migration to a real
 *   industry-config system (per-org Firestore field) cleaner.
 */

export type Industry = "default" | "telecom";

const TELECOM_ORGS = new Set<string>([
  // Demo org for the PR 86 telecom mode foundation. Created by
  // scripts/seedTelecomDemo.cjs (idempotent). Add real customer
  // orgIds here as we onboard them.
  "northwind-fiber-services",
]);

export function getOrgIndustry(orgId: string | null | undefined): Industry {
  const id = String(orgId || "").trim();
  if (id && TELECOM_ORGS.has(id)) return "telecom";
  return "default";
}

export function isTelecomOrg(orgId: string | null | undefined): boolean {
  return getOrgIndustry(orgId) === "telecom";
}

/**
 * Display label for the active industry mode. Used by the
 * /incidents/new badge near the form header (light-touch
 * application per PR 86 scope decisions).
 */
export function industryLabel(industry: Industry): string {
  switch (industry) {
    case "telecom":
      return "Telecom mode";
    case "default":
    default:
      return "";
  }
}
