// PEAKOPS_ARCHETYPE_FROM_TITLE_V1 (PR 126e)
//
// Last-resort archetype resolver for legacy records that have neither
// incident.archetype nor incident.requirements.archetype populated.
// Reads the operator-authored title and matches it against a tiny
// explicit substring map.
//
// Design constraints (per PR 126e plan, approved 2026-06-02):
//   - Explicit substring map. No regex, no fuzzy matching, no AI.
//   - Lowercase-trim-includes match, first-hit wins.
//   - Table is tiny and ordered most-specific-first so future entries
//     for variant phrasings can layer cleanly on top.
//   - Growth is a code-review event, not runtime configuration.
//
// What this helper is NOT:
//   - Not a general intent classifier (only resolves to the archetype
//     enum used by createIncidentV1 / saveOrgTemplateV1).
//   - Not a customer derivation (customer is intentionally NOT inferred
//     from the title — org-wide template lookup only when archetype is
//     title-derived).
//   - Not a write-side path (only used by getCustomerReviewV1 to
//     hydrate the customer dossier; never persisted to Firestore).

// Most-specific phrases first. Add entries as legacy records surface
// in production that can't resolve via direct field reads.
const TITLE_ARCHETYPE_MAP = [
  ["fiber splice verification", "fiber_splice_verification"],
];

function deriveArchetypeFromTitle(title) {
  const lower = String(title || "").trim().toLowerCase();
  if (!lower) return "";
  for (const [needle, archetype] of TITLE_ARCHETYPE_MAP) {
    if (lower.includes(needle)) return archetype;
  }
  return "";
}

module.exports = { deriveArchetypeFromTitle, TITLE_ARCHETYPE_MAP };
