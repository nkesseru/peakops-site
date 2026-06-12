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
  // PEAKOPS_BRANDING_LOGO_VIEW_V1 (2026-05-11) — Slice Branding 1.0.
  /**
   * Organization logo URL for the Summary report header (and any
   * other surface that adopts the logo slot pattern). Sourced from
   * `orgs/{orgId}.branding.logoUrl`. In v1 this is a data URL
   * (admin-uploaded image, base64-encoded, written client-side via
   * the Organization settings tab). A future slice can migrate to a
   * Firebase Storage URL without changing the consumer contract.
   *
   * "" when the org hasn't uploaded a logo yet — the Summary header
   * keeps its permanent empty logo slot so layout never shifts.
   */
  logoUrl: string;
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
  logoUrl: "",
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
  // PEAKOPS_UTILITY_MODE_V1 (2026-05-11) — Slice Utility 1.0.
  // Utility operations flavored copy. Downstream surfaces (Jobs page
  // subhead/filingHint, Start Job placeholder, Summary eyebrow/intro,
  // Mission Control empty state) all read off this view; only the
  // strings change here.
  utilities: {
    startJobTitlePlaceholder: "e.g. Utility outage response — North feeder line",
    startJobSubhead:
      "Open a utility operations job — outage response, inspections, restoration, or infrastructure work.",
    emptyStatePrompt: "Start your first utility operations job",
    filingHint:
      "Field records are structured for operational review, infrastructure tracking, and audit-ready documentation.",
    reportEyebrow: "Utility Operations Record",
    reportIntroLine:
      "Audit-ready record of utility field activity. " +
      "Structured for infrastructure tracking, operational review, and restoration documentation.",
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
  // PEAKOPS_MUNICIPALITY_MODE_V1 (2026-05-11) — Slice Municipality 1.0.
  // Public-works flavored copy. The downstream surfaces (Jobs page
  // subhead/filingHint, Start Job placeholder, Summary eyebrow/intro,
  // Mission Control empty state) already read off this view — only
  // the strings change here.
  municipality: {
    startJobTitlePlaceholder: "e.g. Stormwater inspection — 3rd Ave catch basin",
    startJobSubhead:
      "Open a public works job — roads, stormwater, signals, or contractor verification.",
    emptyStatePrompt: "Start your first public works job",
    // PEAKOPS_MUNICIPALITY_MODE_V1 — neutralized the prior FEMA/grant
    // emphasis. Public records, contractor oversight, and audit-ready
    // documentation are the buyer's actual day-to-day framing; FEMA
    // / grants remain available as a future-reporting output but
    // don't need to dominate the Jobs page hint.
    filingHint:
      "Field records are structured for public records, contractor oversight, and audit-ready documentation.",
    reportEyebrow: "Public Works Operations Record",
    reportIntroLine:
      "Audit-ready record of public works field activity. " +
      "Structured for contractor oversight, public records, and operational review.",
  },
  // PEAKOPS_CONTRACTOR_MODE_V1 (2026-05-12) — Slice Infrastructure
  // Contractor 1.0. Contractor-flavored downstream copy. The
  // pre-existing Contractor Field Record eyebrow is preserved;
  // subhead, filingHint, empty state, intro paragraph, and the
  // starter-job placeholder are all freshly authored to match
  // the proof-of-work / closeout / handoff framing buyers
  // recognize.
  contractor: {
    startJobTitlePlaceholder: "e.g. Job closeout verification — East service corridor",
    startJobSubhead:
      "Open a contractor field job — proof of work, closeouts, safety, or client handoff records.",
    emptyStatePrompt: "Start your first contractor field job",
    filingHint:
      "Field records are structured for proof of work, client review, change-order support, and audit-ready documentation.",
    reportEyebrow: "Contractor Field Record",
    reportIntroLine:
      "Audit-ready record of contractor field activity. " +
      "Structured for proof of work, client review, and project closeout documentation.",
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
// PEAKOPS_MUNICIPALITY_MODE_V1 (2026-05-11) — added municipal keys.
// PEAKOPS_UTILITY_MODE_V1 (2026-05-11) — added utility keys.
// PEAKOPS_CONTRACTOR_MODE_V1 (2026-05-12) — Slice Infrastructure
// Contractor 1.0 adds the four new contractor-specific
// placeholders: job_closeout, site_condition, change_order,
// client_handoff. Existing placeholders are untouched.
const TEMPLATE_TITLE_PLACEHOLDER: Partial<Record<WorkflowTemplateKey, string>> = {
  pole_top:                "e.g. Replace broken pole-top pin — Pole 14A-22",
  fiber_splice:            "e.g. Fiber splice verification — North Line Segment B",
  storm_assess:            "e.g. Storm damage inspection — Utility Corridor 7",
  trench_inspection:       "e.g. Utility trench inspection — Riverside Sub-feeder",
  road_damage:             "e.g. Road damage assessment — Sprague Ave",
  traffic_signal:          "e.g. Traffic signal repair — Pines & Mission",
  stormwater_inspection:   "e.g. Stormwater inspection — 3rd Ave catch basin",
  row_inspection:          "e.g. Sidewalk / right-of-way inspection — Sullivan Rd corridor",
  contractor_verification: "e.g. Contractor work verification — Sullivan sidewalk repair",
  utility_outage:          "e.g. Utility outage response — North feeder line",
  transformer_maintenance: "e.g. Transformer maintenance — Cedar Substation",
  vegetation_management:   "e.g. Vegetation management — Cedar feeder right-of-way",
  safety_verification:     "e.g. Safety verification — Cedar Substation",
  job_closeout:            "e.g. Job closeout verification — East service corridor",
  site_condition:          "e.g. Site condition documentation — South staging yard",
  change_order:            "e.g. Change-order field record — East corridor Sta. 04+50",
  client_handoff:          "e.g. Client handoff packet — East corridor project close",
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

  // PEAKOPS_MUNICIPALITY_MODE_V1 (2026-05-11) — added 5 municipal keys.
  // PEAKOPS_UTILITY_MODE_V1 (2026-05-11) — added 4 utility keys.
  // PEAKOPS_CONTRACTOR_MODE_V1 (2026-05-12) — adds 4 contractor keys.
  // Validation list grows in parallel with WorkflowTemplateKey.
  const validTemplates: WorkflowTemplateKey[] = [
    "pole_top",
    "fiber_splice",
    "storm_assess",
    "trench_inspection",
    "road_damage",
    "stormwater_inspection",
    "traffic_signal",
    "row_inspection",
    "contractor_verification",
    "utility_outage",
    "transformer_maintenance",
    "vegetation_management",
    "safety_verification",
    "job_closeout",
    "site_condition",
    "change_order",
    "client_handoff",
    "blank",
  ];
  const rawTemplate = String(stateData.selectedTemplate || "").trim().toLowerCase();
  const selectedTemplate: WorkflowTemplateKey | "" =
    (validTemplates as string[]).includes(rawTemplate) ? (rawTemplate as WorkflowTemplateKey) : "";

  const displayName = String(orgData.name || stateData.orgName || "").trim();

  // PEAKOPS_BRANDING_LOGO_VIEW_V1 (2026-05-11) — Slice Branding 1.0.
  // Resolve the org logo from `orgs/{orgId}.branding.logoUrl`. The
  // field can be absent (no logo uploaded yet) or carry either a
  // data: URL (v1 client-side upload) or an https: URL (future
  // Storage-backed slice). Defensive type check so a malformed
  // value (number, object, etc.) never paints in an <img src>.
  const branding = (orgData as any)?.branding;
  const rawLogoUrl =
    branding && typeof branding === "object" ? branding.logoUrl : undefined;
  const logoUrl =
    typeof rawLogoUrl === "string" &&
    (rawLogoUrl.startsWith("data:") || rawLogoUrl.startsWith("https://"))
      ? rawLogoUrl
      : "";

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
      logoUrl,
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
    logoUrl,
  };
}
