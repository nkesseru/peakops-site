/**
 * PEAKOPS_NEW_INCIDENT_DRAFT_V1 (PR 70)
 *
 * Shared types + client-side validation for the proof-workflow
 * draft-record creation form (/incidents/new). Mirrors the server
 * contract in functions_clean/createIncidentV1.js (PR 68 + 68b)
 * so the UI catches bad input before the round-trip, but the
 * server remains authoritative — if these drift, the server's
 * 400 message surfaces in the form's error banner.
 *
 * Keep this file dependency-light. It is imported by:
 *   - app/incidents/new/NewIncidentClient.tsx (form)
 * and may later be imported by an incident detail page that
 * surfaces these labels for display.
 */

export const WORK_TYPE_VALUES = [
  "field_operation",
  "field_maintenance",
  "inspection",
  "compliance_audit",
  "other",
] as const;
export type WorkType = (typeof WORK_TYPE_VALUES)[number];

export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  field_operation: "Field operation",
  field_maintenance: "Field maintenance",
  inspection: "Inspection",
  compliance_audit: "Compliance audit",
  other: "Other",
};

export const ARCHETYPE_VALUES = [
  "pole_inspection",
  "splice_work",
  "cable_install",
  "site_survey",
  "custom",
] as const;
export type Archetype = (typeof ARCHETYPE_VALUES)[number];

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  pole_inspection: "Pole inspection",
  splice_work: "Splice work",
  cable_install: "Cable install",
  site_survey: "Site survey",
  custom: "Custom",
};

export const PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITY_VALUES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const TITLE_MIN = 5;
export const TITLE_MAX = 120;
export const LOCATION_MAX = 200;
export const CUSTOMER_MAX = 120;
export const EXT_WO_MAX = 64;
export const NOTES_MAX = 280;

export const EXT_WO_PATTERN = /^[A-Za-z0-9_-]+$/;

export type NewIncidentDraft = {
  title: string;
  workType: WorkType | "";
  archetype: Archetype | "";
  priority: Priority;
  location: string;
  customer: string;
  externalWorkOrderId: string;
  notes: string;
};

export const EMPTY_DRAFT: NewIncidentDraft = {
  title: "",
  workType: "",
  archetype: "",
  priority: "normal",
  location: "",
  customer: "",
  externalWorkOrderId: "",
  notes: "",
};

export type DraftErrors = Partial<Record<keyof NewIncidentDraft, string>>;

export function validateDraft(d: NewIncidentDraft): DraftErrors {
  const e: DraftErrors = {};
  const title = d.title.trim();
  if (!title) {
    e.title = "Required.";
  } else if (title.length < TITLE_MIN) {
    e.title = `Must be at least ${TITLE_MIN} characters.`;
  } else if (title.length > TITLE_MAX) {
    e.title = `Must be ${TITLE_MAX} characters or fewer.`;
  }

  if (!d.workType) {
    e.workType = "Pick a work type.";
  } else if (!WORK_TYPE_VALUES.includes(d.workType)) {
    e.workType = "Unknown work type.";
  }

  if (!d.archetype) {
    e.archetype = "Pick a workflow archetype.";
  } else if (!ARCHETYPE_VALUES.includes(d.archetype)) {
    e.archetype = "Unknown archetype.";
  }

  if (d.location.trim().length > LOCATION_MAX) {
    e.location = `Must be ${LOCATION_MAX} characters or fewer.`;
  }

  if (d.customer.trim().length > CUSTOMER_MAX) {
    e.customer = `Must be ${CUSTOMER_MAX} characters or fewer.`;
  }

  const extWo = d.externalWorkOrderId.trim();
  if (extWo) {
    if (extWo.length > EXT_WO_MAX) {
      e.externalWorkOrderId = `Must be ${EXT_WO_MAX} characters or fewer.`;
    } else if (!EXT_WO_PATTERN.test(extWo)) {
      e.externalWorkOrderId = "Letters, digits, _ and - only.";
    }
  }

  if (d.notes.trim().length > NOTES_MAX) {
    e.notes = `Must be ${NOTES_MAX} characters or fewer.`;
  }

  return e;
}

export function isDraftSubmittable(d: NewIncidentDraft): boolean {
  return Object.keys(validateDraft(d)).length === 0;
}

/**
 * Build the request payload sent to /api/fn/createIncidentV1.
 * Empty optional fields are omitted so the server's "persist when
 * non-empty" rule applies cleanly.
 */
export function buildCreatePayload(
  d: NewIncidentDraft,
  orgId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    orgId,
    title: d.title.trim(),
    status: "draft",
    workType: d.workType,
    archetype: d.archetype,
    priority: d.priority,
  };
  const loc = d.location.trim();
  if (loc) payload.location = loc;
  const cust = d.customer.trim();
  if (cust) payload.customer = cust;
  const extWo = d.externalWorkOrderId.trim();
  if (extWo) payload.externalWorkOrderId = extWo;
  const notes = d.notes.trim();
  if (notes) payload.notes = notes;
  return payload;
}
