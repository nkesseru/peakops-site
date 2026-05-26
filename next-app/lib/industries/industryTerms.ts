/**
 * PEAKOPS_INDUSTRY_TERMS_V1 (PR 86)
 *
 * Industry-aware vocabulary helper. Defines the visible word for
 * each generic concept across PeakOps's supported industries.
 *
 * Application policy (PR 86 light-touch scope):
 *   This helper is BUILT in full but only applied in a SMALL set
 *   of call sites in PR 86:
 *     1. The telecom-mode badge near /incidents/new header
 *     2. The template card descriptions
 *     3. The archetype-aware handoff line on NextBestAction
 *
 *   Broader application across Records, Dashboard, Review,
 *   Summary, sealed-record copy, etc. is staged in focused
 *   follow-up PRs. Each surface gets its own smoke + critique
 *   pass so we never ship a 50-string global swap in one review.
 *
 * Why this matters strategically:
 *   PeakOps's commercial wedge is "the system that prevents
 *   incomplete telecom closeouts." A real telecom operator
 *   should see "Work Package" and "Closeout Packet" — not
 *   "Incident" and "Dossier" — when they're in the app. This
 *   helper is the surface where that translation happens.
 */

import type { Industry } from "./orgIndustry";

export type TermKey =
  | "incident"
  | "dossier"
  | "evidence"
  | "supervisorReview"
  | "summary"
  | "closed"
  | "open"
  | "approved"
  | "operationalRecord"
  | "eventTimeline";

const TERMS: Record<Industry, Record<TermKey, string>> = {
  default: {
    incident: "Field record",
    dossier: "Dossier",
    evidence: "Proof",
    supervisorReview: "Supervisor Review",
    summary: "Summary",
    closed: "Accepted",
    open: "Open",
    approved: "Approved",
    operationalRecord: "Field record",
    eventTimeline: "Event timeline",
  },
  telecom: {
    incident: "Work Package",
    dossier: "Closeout Packet",
    evidence: "Proof",
    supervisorReview: "QA Review",
    summary: "Acceptance Summary",
    closed: "Accepted",
    open: "In Progress",
    approved: "QA Approved",
    operationalRecord: "Field Proof Record",
    eventTimeline: "Work Package Timeline",
  },
};

/**
 * Look up the user-facing term for a given concept in the
 * active industry mode.
 */
export function term(industry: Industry, key: TermKey): string {
  return TERMS[industry]?.[key] ?? TERMS.default[key];
}
