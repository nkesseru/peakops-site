// PEAKOPS_VALIDATION_REALITY_ADAPTER_V1 (PR 133A)
//
// Normalizes raw Firestore incident payloads into the shape the
// validation engine expects, WITHOUT modifying the rulepacks
// themselves or the engine internals.
//
// Problem this solves (verified directly against production data):
//   1. Production status values are lowercase ("draft", "open",
//      "in_progress", "submitted", "closed", "customer_accepted",
//      "customer_rejected", "approved"). Rulepacks `when.statusIn`
//      use UPPERCASE regulatory lifecycle values ("DRAFT", "ACTIVE",
//      "MITIGATED", "CLOSED").
//   2. Production `location` is a free-text string (e.g. "QA Yard 103",
//      "East service corridor · Sta. 04+50 to 08+00"). The OE_417
//      rulepack expects `location.state`. Without normalization,
//      `getByDotPath(incident, "location.state")` returns undefined
//      on every production incident — a false positive of "missing
//      state" when the underlying issue is "we stored location as
//      string".
//
// What this adapter does:
//   - status → uppercase + mapped to the regulatory lifecycle
//   - location string → object shape, surfacing the raw text under
//     `location.raw` so a future rule can inspect it or downstream
//     code can offer suggestions
//   - location object → passthrough (whatever shape the incident has)
//
// What this adapter does NOT do:
//   - Does not parse state codes out of free-text location strings
//     (NLP work; out of scope; the existing rule will correctly
//     report `location.state` missing for these cases)
//   - Does not invent missing fields like `affectedCustomers`
//   - Does not introduce new rules; only normalizes the input shape
//   - Does not write or persist anything; pure function

/** Lifecycle states the rulepacks reason about. */
export type RegulatoryStatus = "DRAFT" | "ACTIVE" | "MITIGATED" | "CLOSED";

/**
 * Map a raw incident.status (any case, any PeakOps lifecycle value) to
 * the regulatory lifecycle value the rulepacks use. Returns "" when
 * the raw value can't be mapped — this lets the WHEN check fail
 * closed (rule doesn't fire) rather than misfire.
 *
 * The mapping is intentionally conservative:
 *   - `draft`                       → DRAFT
 *   - `customer_accepted`, `closed` → CLOSED (incident is done)
 *   - everything else non-empty     → ACTIVE (incident is in motion;
 *     the rulepacks treat ACTIVE and MITIGATED equivalently for the
 *     gates that currently exist, so we pick ACTIVE as the default)
 *   - empty/unknown                 → ""
 */
export function normalizeStatusForValidation(rawStatus: unknown): RegulatoryStatus | "" {
  const s = String(rawStatus == null ? "" : rawStatus).trim().toLowerCase();
  if (!s) return "";

  // Already a canonical regulatory value (rare in practice, but if a
  // caller passes uppercase, respect it).
  switch (s) {
    case "draft":
      return "DRAFT";
    case "active":
      return "ACTIVE";
    case "mitigated":
      return "MITIGATED";
    case "closed":
    case "customer_accepted":
      return "CLOSED";
  }

  // PeakOps lifecycle values that map to ACTIVE (the incident has
  // progressed past draft, isn't terminally closed).
  const ACTIVE_LIKE = new Set([
    "open",
    "in_progress",
    "in-progress",
    "inprogress",
    "submitted",
    "submitted_to_customer",
    "approved",
    "customer_rejected",
    "awaiting_customer",
    "escalated",
  ]);
  if (ACTIVE_LIKE.has(s)) return "ACTIVE";

  // Anything else: unknown → empty so the WHEN gate fails closed.
  return "";
}

/**
 * Normalize a raw incident object into the shape the validation engine
 * can reason about. Returns a NEW object (does not mutate input).
 *
 * Currently normalizes:
 *   - location: string → { raw: <string> } (state still missing,
 *     which lets the OE_417 rule fire correctly)
 *   - filingTypesRequired: ensures array
 *
 * Other fields pass through untouched. Status is NOT normalized here
 * because the rulepack executor and crossField checker normalize at
 * the point of comparison (so we don't double-rewrite the field on
 * the object).
 */
export function normalizeIncidentForValidation<T extends Record<string, unknown>>(raw: T): T {
  const out: Record<string, unknown> = { ...raw };

  // Location: string → object shape.
  const loc = (raw as any).location;
  if (typeof loc === "string") {
    out.location = { raw: loc };
  } else if (loc && typeof loc === "object") {
    // Already an object — pass through.
    out.location = loc;
  } else {
    // Absent — give the engine a stable empty object so dot-path
    // lookups return undefined instead of crashing.
    out.location = {};
  }

  // filingTypesRequired: ensure array shape.
  if (!Array.isArray((raw as any).filingTypesRequired)) {
    out.filingTypesRequired = [];
  }

  return out as T;
}
