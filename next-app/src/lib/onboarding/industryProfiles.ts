// PEAKOPS_ONBOARDING_INDUSTRY_PROFILE_V1 (2026-05-06)
//
// Industry → operating-mode profile. Used by:
//   - the onboarding flow (preselect template, sample first job)
//   - the org doc (industryProfileVersion + key persisted to
//     orgs/{orgId} so the field/review/report surfaces can adapt
//     terminology + timer labels per industry without re-reading
//     the full mapping every render)
//   - future compliance-output hints (telecom NORS/DIRS, etc.) —
//     surfaced today as "future reporting support" copy only;
//     no regulatory submission pipeline is wired in v1.
//
// IMPORTANT: NORS / DIRS / FEMA / grant references in this file
// are PROFILE LABELS the buyer can see, not active filing
// pipelines. Any UI that surfaces them must call them "future
// reporting support" or equivalent honest copy.

export type IndustryKey =
  | "utilities"
  | "telecom"
  | "municipality"
  | "contractor"
  | "other";

// PEAKOPS_MUNICIPALITY_MODE_V1 (2026-05-11) — Slice Municipality 1.0
// added municipal workflow keys.
// PEAKOPS_UTILITY_MODE_V1 (2026-05-11) — Slice Utility 1.0 adds
// utility-specific keys: utility_outage, transformer_maintenance,
// vegetation_management, safety_verification. The existing pole_top
// and storm_assess keys keep their labels and are reused for the
// utility "Pole inspection" and "Damage assessment" recommended
// cards respectively — same template, surfaced where it matters.
// All additions are additive; telecom/municipality/contractor/other
// paths are unaffected.
export type WorkflowTemplateKey =
  | "pole_top"
  | "fiber_splice"
  | "storm_assess"
  | "trench_inspection"
  | "road_damage"
  | "stormwater_inspection"
  | "traffic_signal"
  | "row_inspection"
  | "contractor_verification"
  | "utility_outage"
  | "transformer_maintenance"
  | "vegetation_management"
  | "safety_verification"
  | "blank";

export type IndustryProfile = {
  key: IndustryKey;
  label: string;
  short: string;
  defaultWorkflow: WorkflowTemplateKey;
  /**
   * Templates this industry treats as "Recommended" in the workflow
   * picker. The first entry is the auto-selected default. Order
   * matters — earlier entries get the prominent visual treatment.
   * Always includes `defaultWorkflow` as the first entry.
   */
  recommendedWorkflows: ReadonlyArray<WorkflowTemplateKey>;
  starterJob: {
    title: string;
    location: string;
    jobType: "repair" | "damage" | "inspection" | "other";
  };
  terminology: ReadonlyArray<string>;
  timerLabels: {
    response: string;
    fieldArrival: string;
    completion: string;
  };
  outputs: ReadonlyArray<{
    label: string;
    /** How honest the buyer-facing copy must be about today's wiring. */
    status: "live" | "future";
  }>;
  /**
   * PEAKOPS_ONBOARDING_OPS_FOCUS_V1 (2026-05-08)
   * Per-industry "Operational Focus" checklist shown on the
   * Operational Focus step. Helps PeakOps tailor workflows, reports,
   * and operational guidance to the kind of work the buyer's team
   * manages most. Selections are saved to onboarding state's
   * opsFocus.selected[] and are PERSONALIZATION HINTS only — they
   * never gate access to features.
   *
   * IMPORTANT: any option that references a regulator (NORS / DIRS /
   * FEMA / grants) MUST keep the filing-aware qualifier in `note`.
   * PeakOps helps STRUCTURE operational records for those filings;
   * it does not submit anything. Final filings remain the customer's
   * responsibility unless future integrations are added.
   */
  opsFocusOptions: ReadonlyArray<{
    key: string;          // stable id, persisted in selected[]
    label: string;        // primary copy
    note?: string;        // optional clarifier (esp. for regulator refs)
  }>;
};

const PROFILES: Record<IndustryKey, IndustryProfile> = {
  // PEAKOPS_UTILITY_MODE_V1 (2026-05-11) — Slice Utility 1.0.
  // Re-tuned for utility operations buyers per the Utility Mode 1.0
  // spec: outage response / inspection / restoration / vegetation
  // language. Subhead, recommended workflows, opsFocus options, and
  // outputs now reflect a utility operations team's day-to-day.
  utilities: {
    key: "utilities",
    label: "Utility Operations",
    short: "Outage response, infrastructure inspection, vegetation management, and utility field operations",
    defaultWorkflow: "utility_outage",
    recommendedWorkflows: [
      "utility_outage",
      "pole_top",
      "transformer_maintenance",
      "storm_assess",
      "vegetation_management",
      "safety_verification",
    ],
    starterJob: {
      title: "Utility outage response — North feeder line",
      location: "North feeder line · Section 14A",
      jobType: "damage",
    },
    terminology: ["pole", "feeder", "substation", "transformer", "right-of-way", "outage"],
    timerLabels: {
      response: "Response time",
      fieldArrival: "Field arrival",
      completion: "Restoration window",
    },
    outputs: [
      { label: "Audit-ready field record", status: "live" },
      { label: "Operational review packet", status: "live" },
      { label: "Infrastructure inspection report", status: "live" },
    ],
    opsFocusOptions: [
      { key: "outage_restoration",  label: "Outage restoration",       note: "Document outages, crews, and restoration timelines as they happen." },
      { key: "pole_inspection",     label: "Pole inspection",          note: "Recurring inspection cycles with photo evidence." },
      { key: "transformer_inspection", label: "Transformer inspection", note: "Substation and field-mounted transformer condition checks." },
      { key: "vegetation_management", label: "Vegetation management",  note: "Right-of-way trimming, hazard trees, and clearance work." },
      { key: "safety_inspection",   label: "Safety inspection",        note: "Routine safety walkarounds and substation safety logs." },
      { key: "damage_assessment",   label: "Damage assessment",        note: "Storm or incident damage assessments with photo evidence." },
      { key: "emergency_response",  label: "Utility emergency response", note: "Storm and critical event response with rapid documentation." },
    ],
  },

  telecom: {
    key: "telecom",
    label: "Telecom",
    short: "Fiber · OSP · splice work",
    defaultWorkflow: "fiber_splice",
    recommendedWorkflows: ["fiber_splice", "trench_inspection", "storm_assess"],
    starterJob: {
      title: "Fiber splice verification — North Line Segment B",
      location: "North Line Segment B · Splice cabinet NLB-04",
      jobType: "inspection",
    },
    terminology: ["site", "segment", "cabinet", "splice", "outage window", "restoration"],
    timerLabels: {
      response: "Interruption window",
      fieldArrival: "Field response",
      completion: "Restoration time",
    },
    // PEAKOPS_TELECOM_FUTURE_REPORTING_V1 (2026-05-06)
    // NORS = FCC Network Outage Reporting System.
    // DIRS = Disaster Information Reporting System.
    // Both are real US carrier-side filing systems. PeakOps does
    // NOT submit to either today. We surface them ONLY as planned
    // outputs so a telecom buyer sees the compliance pathway is
    // in scope. UI must label these as "future reporting support".
    outputs: [
      { label: "Audit-ready field record", status: "live" },
      { label: "Splice/outage closeout packet", status: "live" },
      { label: "NORS-ready outage record (future reporting support)", status: "future" },
      { label: "DIRS-ready disaster impact record (future reporting support)", status: "future" },
    ],
    opsFocusOptions: [
      { key: "outage_tracking",      label: "Outage tracking",                    note: "Capture interruption windows, affected areas, and restoration steps." },
      { key: "restoration_timelines",label: "Restoration timeline documentation" },
      { key: "splice_logs",          label: "Splice / OSP work logs" },
      { key: "contractor_verification", label: "Contractor verification" },
      { key: "infrastructure_inspection", label: "Infrastructure inspection" },
      // PEAKOPS_TELECOM_FUTURE_REPORTING_V1 — filing-aware copy.
      { key: "filing_ready_records", label: "NORS / DIRS-style operational records", note: "PeakOps helps structure operational records for NORS/DIRS-style documentation. Not legal/compliance advice — final filings remain your team's responsibility." },
    ],
  },

  // PEAKOPS_MUNICIPALITY_MODE_V1 (2026-05-11) — Slice Municipality 1.0.
  // Re-tuned for public-works buyers per the Municipality Mode 1.0
  // spec: ops focus presets, recommended templates, terminology, and
  // outputs now reflect roads / stormwater / signals / contractor
  // verification rather than utility-corridor language.
  municipality: {
    key: "municipality",
    label: "Municipality / Public Works",
    short: "Roads, stormwater, signals, and contractor field verification",
    defaultWorkflow: "stormwater_inspection",
    recommendedWorkflows: [
      "stormwater_inspection",
      "road_damage",
      "traffic_signal",
      "row_inspection",
      "contractor_verification",
    ],
    starterJob: {
      title: "Stormwater inspection — 3rd Ave catch basin",
      location: "3rd Ave · Catch basin CB-12",
      jobType: "inspection",
    },
    terminology: ["public works", "right-of-way", "signal cabinet", "catch basin", "corridor"],
    timerLabels: {
      response: "Response time",
      fieldArrival: "Inspection window",
      completion: "Closure window",
    },
    outputs: [
      { label: "Audit-ready field record", status: "live" },
      { label: "Contractor oversight packet", status: "live" },
      { label: "Public records / council-ready summary", status: "live" },
      { label: "FEMA / grant-ready field record (future reporting support)", status: "future" },
    ],
    opsFocusOptions: [
      { key: "road_damage",          label: "Road damage response",                note: "Document potholes, damage, and emergency road repairs as they happen." },
      { key: "stormwater",           label: "Stormwater inspection",               note: "Catch basins, drainage, and stormwater events." },
      { key: "traffic_signals",      label: "Traffic signal repair",               note: "Signal cabinets, lighting, and intersection maintenance." },
      { key: "row_oversight",        label: "Sidewalk / right-of-way inspection",  note: "Curbs, sidewalks, and right-of-way condition." },
      { key: "contractor_oversight", label: "Contractor oversight",                note: "Verify contractor work — punch items, sign-off, and proof-of-work." },
      { key: "emergency_response",   label: "Public works emergency response",     note: "Storm and incident response with rapid documentation." },
      { key: "filing_ready_records", label: "FEMA / grant-ready field records",    note: "PeakOps helps structure operational records for FEMA/grant-style documentation. Not legal/compliance advice — final filings remain your team's responsibility." },
    ],
  },

  contractor: {
    key: "contractor",
    label: "Infrastructure Contractor",
    short: "Multi-customer field crews",
    defaultWorkflow: "trench_inspection",
    recommendedWorkflows: ["trench_inspection", "pole_top", "storm_assess"],
    starterJob: {
      title: "Utility trench inspection — Riverside Sub-feeder",
      location: "Riverside Sub-feeder · Stations 18+50 to 22+00",
      jobType: "inspection",
    },
    terminology: ["crew", "subcontractor", "site", "scope", "punch item"],
    timerLabels: {
      response: "Dispatch time",
      fieldArrival: "Crew arrival",
      completion: "Completion window",
    },
    outputs: [
      { label: "Client-ready proof of work", status: "live" },
      { label: "Closeout packet", status: "live" },
    ],
    opsFocusOptions: [
      { key: "job_verification",  label: "Job verification & photo documentation" },
      { key: "closeout_packets",  label: "Per-client closeout packets" },
      { key: "punch_tracking",    label: "Punch-item tracking" },
      { key: "safety_walkaround", label: "Safety walkaround documentation" },
      { key: "daily_reports",     label: "Customer-facing daily reports" },
    ],
  },

  other: {
    key: "other",
    label: "Other",
    short: "Custom — we'll tailor the profile after setup",
    defaultWorkflow: "blank",
    recommendedWorkflows: ["blank"],
    starterJob: {
      title: "First operational job",
      location: "",
      jobType: "other",
    },
    terminology: ["site", "team", "job", "report"],
    timerLabels: {
      response: "Start time",
      fieldArrival: "Review time",
      completion: "Completion time",
    },
    outputs: [
      { label: "Audit-ready job record", status: "live" },
    ],
    opsFocusOptions: [
      { key: "audit_ready_records", label: "Audit-ready field records" },
      { key: "photo_evidence",      label: "Photo evidence chains" },
      { key: "custom_packets",      label: "Custom report packets" },
    ],
  },
};

export const INDUSTRY_PROFILE_VERSION = "v1.0";

export function getIndustryProfile(key: IndustryKey | string | null | undefined): IndustryProfile {
  const k = String(key || "").trim().toLowerCase() as IndustryKey;
  if (k && (k in PROFILES)) return PROFILES[k];
  return PROFILES.other;
}

export function listIndustryProfiles(): ReadonlyArray<IndustryProfile> {
  return [
    PROFILES.utilities,
    PROFILES.telecom,
    PROFILES.municipality,
    PROFILES.contractor,
    PROFILES.other,
  ];
}
