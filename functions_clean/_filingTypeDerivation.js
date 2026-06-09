// PEAKOPS_FILING_TYPE_DERIVATION_V1 (PR 133A)
//
// Derives `filingTypesRequired` for an incident from its archetype +
// other real characteristics. Used by createIncidentV1 at creation
// time so the validation engine has real filing types to act on.
//
// Architecture lock (PR 133A scope):
//   - Read-only mapping; never writes data
//   - Conservative by design — empty `[]` is a valid result and the
//     correct result for the majority of PeakOps incidents (which are
//     field-work records, not regulatory outage reports)
//   - No new rulepacks; just populates the existing `filingTypesRequired`
//     field with a value the engine can consume
//
// Single mapping (today): the only archetype that maps to an FCC
// filing is `storm_restoration_proof` — telecom storm-response work
// that downstream feeds DIRS. Every other archetype produces `[]`,
// which is the honest answer (no filing required) for verification /
// inspection / acceptance / general field work.
//
// When the product grows new outage archetypes (e.g. `fiber_outage_response`,
// `power_grid_disruption`), add them to FILING_TYPE_BY_ARCHETYPE.
// New rulepack work belongs elsewhere; this helper is purely a mapping.

const FILING_TYPE_BY_ARCHETYPE = Object.freeze({
  // Storm-restoration field work follows from an outage event the
  // operator was dispatched for. DIRS is the FCC's outage-reporting
  // form for telecom. We attribute the filing requirement here so the
  // operational record (the field-work incident) carries the same
  // filing context as the upstream outage event.
  storm_restoration_proof: ["DIRS"],
});

/**
 * Derive the filingTypesRequired array from an incident's
 * characteristics. Returns an empty array when no characteristic
 * matches a known regulatory filing type.
 *
 * @param {object} args
 * @param {string} [args.archetype]    canonical archetype enum value
 * @param {string} [args.jobType]      optional secondary signal
 * @param {string} [args.workType]     optional tertiary signal
 * @returns {string[]} filing-type enum values (e.g. ["DIRS"])
 */
function deriveFilingTypes({ archetype = "", jobType = "", workType = "" } = {}) {
  const a = String(archetype || "").trim().toLowerCase();
  if (a && FILING_TYPE_BY_ARCHETYPE[a]) {
    // Defensive copy — never share the frozen array reference with
    // callers who may try to mutate it.
    return [...FILING_TYPE_BY_ARCHETYPE[a]];
  }
  // Future expansion points (jobType, workType) intentionally left
  // unmapped — adding them here is the seam for future product
  // growth, not for current production data.
  void jobType;
  void workType;
  return [];
}

module.exports = {
  deriveFilingTypes,
  FILING_TYPE_BY_ARCHETYPE,
};
