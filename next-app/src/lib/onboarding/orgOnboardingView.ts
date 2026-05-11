// PEAKOPS_ONBOARDING_DOWNSTREAM_VIEW_V1 (2026-05-08)
//
// Slice Onboarding 1.2: read-only view of an org's onboarding
// configuration, used by downstream surfaces to swap copy and
// affordances based on the buyer's selections from the wizard.
//
// Data sources (both are member-gated by Slice 8 rules — any
// signed-in active member of the org can read both):
//   - orgs/{orgId}                                  ← industry,
//                                                    industryProfileVersion,
//                                                    contact fields
//   - orgs/{orgId}/onboarding/state                 ← selectedTemplate,
//                                                    opsFocus,
//                                                    firstJobDraft
//
// Both reads are best-effort. If either snapshot is missing or
// unreadable, the helper returns the empty default so the consuming
// UI falls back to its hard-coded generic copy. Failure modes never
// throw past this layer — Mission Control should never fail-load
// because the onboarding doc happens to be missing.
//
// FILING-HONEST CONTRACT: telecom copy mentions NORS/DIRS-style
// documentation but always carries the qualifier
// "Final filings remain your responsibility" — same posture as the
// onboarding wizard. PeakOps does not submit to any regulator.

import { doc, getDoc } from "firebase/firestore";
import { db } from "../../../lib/firebaseClient";
import {
  getIndustryProfile,
  type IndustryKey,
  type WorkflowTemplateKey,
} from "./industryProfiles";

export type OrgOnboardingView = {
  /** Resolved industry key, or "" if the org hasn't picked one yet. */
  industry: IndustryKey | "";
  /** Capitalized industry label (e.g. "Telecom") or "" when no industry. */
  industryLabel: string;
  /** Workflow template the buyer chose during onboarding, "" if none. */
  selectedTemplate: WorkflowTemplateKey | "";
  /** Org name to display in chrome (falls back to "your organization"). */
  displayName: string;
  /** Title placeholder for the Start Job form. Industry-flavored. */
  startJobTitlePlaceholder: string;
  /** Subhead under "Start a Job" eyebrow. Industry-flavored. */
  startJobSubhead: string;
  /** First-line empty-state copy on Mission Control. Industry-flavored. */
  emptyStatePrompt: string;
  /**
   * Optional filing-aware hint, currently shown for telecom and
   * municipality only. Always paired with the "final filings remain
   * your responsibility" qualifier — we never imply auto-submission.
   * `null` for industries without filing-style outputs in their profile.
   */
  filingHint: string | null;
  // PEAKOPS_REPORT_HEADER_VIEW_V1 (2026-05-08) — Slice Start Job 1.0.
  /**
   * Letter-spaced uppercase eyebrow rendered above the report title
   * on the Summary page. Industry-flavored when an industry is set;
   * "Job Report" by default so the existing surface looks unchanged
   * for orgs that haven't completed onboarding.
   */
  reportEyebrow: string;
  /**
   * Optional italic intro paragraph rendered below the report meta
   * line. Telecom + municipality carry the filing-aware qualifier
   * (NORS/DIRS or FEMA/grants) with the explicit
   * "final filings remain your responsibility" disclaimer.
   * `null` for industries without filing-style outputs.
   */
  reportIntroLine: string | null;
};

export const DEFAULT_ORG_ONBOARDING_VIEW: OrgOnboardingView = {
  industry: "",
  industryLabel: "",
  selectedTemplate: "",
  displayName: "",
  startJobTitlePlaceholder: "e.g. Replace broken pole-top pin",
  startJobSubhead: "Open a new job and start capturing photos.",
  emptyStatePrompt: "Start your first job",
  filingHint: null,
  reportEyebrow: "Job Report",
  reportIntroLine: null,
};

// PEAKOPS_ONBOARDING_DOWNSTREAM_COPY_V1 (2026-05-08)
// Per-industry copy used by the view. Kept in this file so a copy
// edit doesn't fan out across consumer surfaces.
type IndustryCopy = {
  startJobTitlePlaceholder: string;
  startJobSubhead: string;
  emptyStatePrompt: string;
  filingHint: string | null;
  // PEAKOPS_REPORT_HEADER_VIEW_V1 (2026-05-08) — Slice Start Job 1.0.
  // Eyebrow rendered above the report title on the Summary page.
  // Kept short: industry-flavored, no org name (the page chrome
  // already names the org elsewhere). The "Job Report" default lives
  // on DEFAULT_ORG_ONBOARDING_VIEW; per-industry strings override.
  reportEyebrow: string;
  // Italic intro paragraph below the meta line. Filing-aware when
  // the industry has a filing pathway (telecom, municipality);
  // otherwise null (no extra paragraph rendered).
  reportIntroLine: string | null;
};

const INDUSTRY_COPY: Record<IndustryKey, IndustryCopy> = {
  utilities: {
    startJobTitlePlaceholder: "e.g. Replace broken pole-top pin — Pole 14A-22",
    startJobSubhead: "Open a utilities job — pole, feeder, substation, or right-of-way work.",
    emptyStatePrompt: "Start your first utilities job",
    filingHint: null,
    // PEAKOPS_REPORT_EYEBROW_PHRASING_V2 (2026-05-11)
    // Report Presentation 1.0 — "Operations Record" reads more
    // enterprise-grade than "Field Record" for utilities buyers,
    // matching how utilities describe their own operational logs.
    reportEyebrow: "Utility Operations Record",
    reportIntroLine: null,
  },
  telecom: {
    startJobTitlePlaceholder: "e.g. Fiber splice verification — North Line Segment B",
    startJobSubhead: "Open a telecom job — splice, OSP, or outage response work.",
    emptyStatePrompt: "Start your first telecom job",
    // PEAKOPS_TELECOM_FUTURE_REPORTING_V1 — filing-aware copy.
    filingHint:
      "Outage and restoration records are structured for NORS/DIRS-style documentation. " +
      "Final filings remain your responsibility.",
    reportEyebrow: "Telecom Field Record",
    reportIntroLine:
      "Audit-ready record of telecom field activity. " +
      "Structured for NORS/DIRS-style documentation — final filings remain your responsibility.",
  },
  municipality: {
    startJobTitlePlaceholder: "e.g. Storm damage inspection — Utility Corridor 7",
    startJobSubhead: "Open a public-works job — streets, signals, or stormwater.",
    emptyStatePrompt: "Start your first public-works job",
    filingHint:
      "Damage and incident records are structured for FEMA/grant-style documentation. " +
      "Final filings remain your responsibility.",
    // PEAKOPS_REPORT_EYEBROW_PHRASING_V2 (2026-05-11)
    // Report Presentation 1.0 — municipality buyers describe their
    // own work as "operations" (e.g. street operations, signal
    // operations); "Operations Record" reads as their own internal
    // language.
    reportEyebrow: "Public Works Operations Record",
    reportIntroLine:
      "Audit-ready record of public-works activity. " +
      "Structured for FEMA/grant-style documentation — final filings remain your responsibility.",
  },
  contractor: {
    startJobTitlePlaceholder: "e.g. Utility trench inspection — Riverside Sub-feeder",
    startJobSubhead: "Open a job for any of your customers — capture proof of work as you go.",
    emptyStatePrompt: "Start your first job",
    filingHint: null,
    // PEAKOPS_REPORT_EYEBROW_PHRASING_V2 (2026-05-11)
    // Report Presentation 1.0 — "Contractor Field Record" makes
    // the per-client closeout context clear at a glance for a
    // multi-customer contractor.
    reportEyebrow: "Contractor Field Record",
    reportIntroLine: null,
  },
  other: {
    startJobTitlePlaceholder: "e.g. Replace broken pole-top pin",
    startJobSubhead: "Open a new job and start capturing photos.",
    emptyStatePrompt: "Start your first job",
    filingHint: null,
    reportEyebrow: "Job Report",
    reportIntroLine: null,
  },
};

// Optional refinement: when the buyer picked a specific workflow
// template, the title placeholder leans into that template instead
// of the generic industry default. Keeps the cue close to the
// last selection the buyer made in the wizard.
//
// PEAKOPS_ONBOARDING_BLANK_TEMPLATE_FALLTHROUGH_V1 (2026-05-08)
// "blank" is intentionally omitted: a buyer who chose "Start blank"
// has explicitly opted OUT of a workflow-specific template, so the
// placeholder should fall through to the industry default copy
// rather than overriding it with a generic "e.g. Job title" string.
// industry=other + blank → "e.g. Replace broken pole-top pin"
// industry=telecom + blank → telecom industry placeholder
// industry=utilities + blank → utilities placeholder
// (any future workflow-specific template still overrides as expected)
const TEMPLATE_TITLE_PLACEHOLDER: Partial<Record<WorkflowTemplateKey, string>> = {
  pole_top:          "e.g. Replace broken pole-top pin — Pole 14A-22",
  fiber_splice:      "e.g. Fiber splice verification — North Line Segment B",
  storm_assess:      "e.g. Storm damage inspection — Utility Corridor 7",
  trench_inspection: "e.g. Utility trench inspection — Riverside Sub-feeder",
};

/**
 * Read the onboarding view for an org. Best-effort: returns the
 * default view (generic copy) on any read failure. Never throws.
 */
export async function loadOrgOnboardingView(orgId: string): Promise<OrgOnboardingView> {
  if (!orgId) return DEFAULT_ORG_ONBOARDING_VIEW;
  let orgData: Record<string, unknown> = {};
  let stateData: Record<string, unknown> = {};
  try {
    const [orgSnap, stateSnap] = await Promise.all([
      getDoc(doc(db, "orgs", orgId)),
      getDoc(doc(db, "orgs", orgId, "onboarding", "state")),
    ]);
    if (orgSnap.exists()) orgData = orgSnap.data() as Record<string, unknown>;
    if (stateSnap.exists()) stateData = stateSnap.data() as Record<string, unknown>;
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[orgOnboardingView] load failed", String((e as Error)?.message || e));
    }
    return DEFAULT_ORG_ONBOARDING_VIEW;
  }

  const rawIndustry = String(
    orgData.industry || stateData.industry || "",
  ).trim().toLowerCase();
  const validKeys: IndustryKey[] = ["utilities", "telecom", "municipality", "contractor", "other"];
  const industry: IndustryKey | "" =
    (validKeys as string[]).includes(rawIndustry) ? (rawIndustry as IndustryKey) : "";

  const validTemplates: WorkflowTemplateKey[] = [
    "pole_top", "fiber_splice", "storm_assess", "trench_inspection", "blank",
  ];
  const rawTemplate = String(stateData.selectedTemplate || "").trim().toLowerCase();
  const selectedTemplate: WorkflowTemplateKey | "" =
    (validTemplates as string[]).includes(rawTemplate) ? (rawTemplate as WorkflowTemplateKey) : "";

  const displayName = String(orgData.name || stateData.orgName || "").trim();

  if (!industry) {
    // Industry not set — return default copy but include the (possibly
    // empty) displayName + selectedTemplate so consumers can still
    // refine the title placeholder if a template happens to be set.
    const placeholder = selectedTemplate && TEMPLATE_TITLE_PLACEHOLDER[selectedTemplate]
      ? (TEMPLATE_TITLE_PLACEHOLDER[selectedTemplate] as string)
      : DEFAULT_ORG_ONBOARDING_VIEW.startJobTitlePlaceholder;
    return {
      ...DEFAULT_ORG_ONBOARDING_VIEW,
      displayName,
      selectedTemplate,
      startJobTitlePlaceholder: placeholder,
    };
  }

  const profile = getIndustryProfile(industry);
  const copy = INDUSTRY_COPY[industry];
  const placeholder = selectedTemplate && TEMPLATE_TITLE_PLACEHOLDER[selectedTemplate]
    ? (TEMPLATE_TITLE_PLACEHOLDER[selectedTemplate] as string)
    : copy.startJobTitlePlaceholder;

  return {
    industry,
    industryLabel: profile.label,
    selectedTemplate,
    displayName,
    startJobTitlePlaceholder: placeholder,
    startJobSubhead: copy.startJobSubhead,
    emptyStatePrompt: copy.emptyStatePrompt,
    filingHint: copy.filingHint,
    reportEyebrow: copy.reportEyebrow,
    reportIntroLine: copy.reportIntroLine,
  };
}
