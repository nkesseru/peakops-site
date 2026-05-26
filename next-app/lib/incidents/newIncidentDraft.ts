/**
 * PEAKOPS_NEW_INCIDENT_DRAFT_V2 (PR 82)
 *
 * Shared types + client-side validation for the proof-workflow
 * draft-record creation form (/incidents/new). Mirrors the server
 * contract in functions_clean/createIncidentV1.js (PR 68 + 68b
 * + 81a) so the UI catches bad input before the round-trip; the
 * server remains authoritative.
 *
 * v2 changes (PR 82):
 *   - ARCHETYPE_VALUES expanded to the curated proof-workflow set
 *     (fiber_splice_verification, pole_inspection, site_acceptance,
 *     storm_restoration_proof, custom). Backend ARCHETYPE_ENUM
 *     accepts these via PR 81a.
 *   - ARCHETYPE_DETAILS added — purpose, required-proof checklist,
 *     and packet-use copy per archetype, surfaced by the new card
 *     picker in NewIncidentClient.
 *   - WORK_TYPE_* removed. Archetype now carries the operational
 *     classification on its own. Backend still accepts workType
 *     if sent — we just stop sending it.
 *
 * Legacy archetype values (splice_work, cable_install, site_survey)
 * are NOT included here — the picker doesn't surface them. Existing
 * records that carry those values continue to work because the
 * backend still accepts them on read paths.
 */

export const ARCHETYPE_VALUES = [
  "fiber_splice_verification",
  "pole_inspection",
  "site_acceptance",
  "storm_restoration_proof",
  "custom",
] as const;
export type Archetype = (typeof ARCHETYPE_VALUES)[number];

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  fiber_splice_verification: "Fiber splice verification",
  pole_inspection: "Pole inspection",
  site_acceptance: "Site acceptance",
  storm_restoration_proof: "Storm restoration proof",
  custom: "Custom field record",
};

/**
 * Rich metadata for each archetype card on /incidents/new (PR 82).
 *   - purpose: one-sentence framing of what the packet is for
 *   - requiredProof: short checklist of evidence the proof package
 *     will need to feel acceptance-ready
 *   - packetUse: dossier-voice tag line describing how the assembled
 *     packet will be consumed downstream
 */
export const ARCHETYPE_DETAILS: Record<
  Archetype,
  { purpose: string; requiredProof: readonly string[]; packetUse: string }
> = {
  fiber_splice_verification: {
    purpose:
      "Document splice completion for customer acceptance and invoice support.",
    requiredProof: ["Completion photos", "GPS capture", "Supervisor approval"],
    packetUse: "Customer acceptance · Invoice support",
  },
  pole_inspection: {
    purpose:
      "Capture inspection proof for maintenance, QA, or audit review.",
    requiredProof: ["Inspection photos", "Field notes", "QA review"],
    packetUse: "QA / inspection · Internal documentation",
  },
  site_acceptance: {
    purpose: "Package final completion proof for customer sign-off.",
    requiredProof: ["Completion photos", "Redlines", "Supervisor approval"],
    packetUse: "Customer acceptance · Closeout packet",
  },
  storm_restoration_proof: {
    purpose:
      "Capture restoration proof for claims, reimbursement, and after-action review.",
    requiredProof: ["Damage photos", "GPS capture", "Time-stamped notes"],
    packetUse: "Claim support · Reimbursement support",
  },
  custom: {
    purpose:
      "Start a flexible proof package when no standard archetype fits.",
    requiredProof: ["Photos", "Field notes", "Approval"],
    packetUse: "Internal documentation · Custom",
  },
};

/**
 * PEAKOPS_ARCHETYPE_LOOKUP_V1 (PR 84)
 *
 * Graceful lookup for archetype display metadata. Returns null when
 * the value is empty, unknown, or one of the legacy enum keys
 * (splice_work, site_survey, cable_install) that aren't part of
 * the curated PR 81/82 set. Callers (RecordsClient eyebrow,
 * IncidentClient banner checklist) use the null fallback to
 * simply not render archetype-specific UI for legacy records.
 */
export function getArchetypeDetails(
  value: unknown,
): { label: string; purpose: string; requiredProof: readonly string[]; packetUse: string } | null {
  const key = String(value || "").trim();
  if (!key) return null;
  if (!(ARCHETYPE_VALUES as readonly string[]).includes(key)) return null;
  const typed = key as Archetype;
  return {
    label: ARCHETYPE_LABELS[typed],
    ...ARCHETYPE_DETAILS[typed],
  };
}

export const PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITY_VALUES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/**
 * PEAKOPS_PACKET_PURPOSE_V1 (PR 71)
 *
 * Client-only framing field. NOT sent to createIncidentV1 yet
 * (backend doesn't accept this field). Selection lives in the
 * form's useState and drops on submit.
 */
export const PACKET_PURPOSE_VALUES = [
  "customer_acceptance",
  "invoice_support",
  "qa_inspection",
  "claim_support",
  "internal_documentation",
  "custom",
] as const;
export type PacketPurpose = (typeof PACKET_PURPOSE_VALUES)[number] | "";

export const PACKET_PURPOSE_LABELS: Record<Exclude<PacketPurpose, "">, string> = {
  customer_acceptance: "Customer acceptance",
  invoice_support: "Invoice support",
  qa_inspection: "QA / inspection",
  claim_support: "Claim support",
  internal_documentation: "Internal documentation",
  custom: "Custom",
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
  archetype: Archetype | "";
  priority: Priority;
  location: string;
  customer: string;
  externalWorkOrderId: string;
  notes: string;
};

export const EMPTY_DRAFT: NewIncidentDraft = {
  title: "",
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

  if (!d.archetype) {
    e.archetype = "Pick a work package archetype.";
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
 * non-empty" rule applies cleanly. workType is no longer sent
 * (PR 82); archetype now carries the operational classification.
 */
export function buildCreatePayload(
  d: NewIncidentDraft,
  orgId: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    orgId,
    title: d.title.trim(),
    status: "draft",
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
