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

export type WorkflowTemplateKey =
  | "pole_top"
  | "fiber_splice"
  | "storm_assess"
  | "trench_inspection"
  | "blank";

export type IndustryProfile = {
  key: IndustryKey;
  label: string;
  short: string;
  defaultWorkflow: WorkflowTemplateKey;
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
};

const PROFILES: Record<IndustryKey, IndustryProfile> = {
  utilities: {
    key: "utilities",
    label: "Utilities",
    short: "Electric · gas · water",
    defaultWorkflow: "pole_top",
    starterJob: {
      title: "Replace broken pole-top pin — Pole 14A-22",
      location: "Pole 14A-22 · Riser conduit, north face",
      jobType: "repair",
    },
    terminology: ["pole", "feeder", "substation", "utility corridor"],
    timerLabels: {
      response: "Response time",
      fieldArrival: "Field arrival",
      completion: "Restoration window",
    },
    outputs: [
      { label: "Audit-ready field record", status: "live" },
      { label: "Inspection report", status: "live" },
    ],
  },

  telecom: {
    key: "telecom",
    label: "Telecom",
    short: "Fiber · OSP · splice work",
    defaultWorkflow: "fiber_splice",
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
  },

  municipality: {
    key: "municipality",
    label: "Municipality",
    short: "Streets · signals · public infrastructure",
    defaultWorkflow: "storm_assess",
    starterJob: {
      title: "Storm damage inspection — Utility Corridor 7",
      location: "Utility Corridor 7 · MP 12.4",
      jobType: "damage",
    },
    terminology: ["public works", "corridor", "signal cabinet", "right-of-way"],
    timerLabels: {
      response: "Response time",
      fieldArrival: "Inspection window",
      completion: "Closure window",
    },
    outputs: [
      { label: "Audit-ready field record", status: "live" },
      { label: "Council-ready summary", status: "live" },
      { label: "FEMA / grant-ready field record (future reporting support)", status: "future" },
    ],
  },

  contractor: {
    key: "contractor",
    label: "Infrastructure Contractor",
    short: "Multi-customer field crews",
    defaultWorkflow: "trench_inspection",
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
  },

  other: {
    key: "other",
    label: "Other",
    short: "Custom — we'll tailor the profile after setup",
    defaultWorkflow: "blank",
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
