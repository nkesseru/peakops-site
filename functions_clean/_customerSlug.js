/**
 * PEAKOPS_CUSTOMER_SLUG_V1 (PR 91)
 *
 * Shared helper for normalizing a free-text customer string into
 * a slug suitable for use in Firestore doc IDs (PR 91 customer
 * templates). MUST be used by both the read path (createIncidentV1
 * snapshot resolver) and any future write path (admin UI / seed
 * scripts) so the same input maps to the same doc ID consistently.
 *
 * Rules:
 *   - Trim leading/trailing whitespace
 *   - Lowercase ASCII
 *   - Collapse runs of whitespace to a single hyphen
 *   - Strip any character that isn't [a-z0-9-]
 *   - Collapse runs of hyphens to a single hyphen
 *   - Trim leading/trailing hyphens
 *
 * Examples:
 *   "City of Riverbend"                    → "city-of-riverbend"
 *   "  Acme Stormwater Co  "               → "acme-stormwater-co"
 *   "Cascade Broadband Infrastructure"     → "cascade-broadband-infrastructure"
 *   "City of Riverbend — Stormwater Div."  → "city-of-riverbend-stormwater-div"
 *
 * Returns "" for empty / whitespace-only input. Callers should
 * skip customer-specific template lookups in that case.
 *
 * What this helper is NOT:
 *   - Not a hash (slugs are human-readable; collisions possible
 *     if two distinct customer strings normalize to the same slug)
 *   - Not Unicode-aware (intentional — keep doc IDs ASCII for
 *     URL/filesystem portability)
 *   - Not a customer-entity resolver (no Firestore lookup; pure
 *     string transform)
 */

function toCustomerSlug(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return "";
  let slug = raw.toLowerCase();
  slug = slug.replace(/\s+/g, "-");
  slug = slug.replace(/[^a-z0-9-]/g, "");
  slug = slug.replace(/-+/g, "-");
  slug = slug.replace(/^-+|-+$/g, "");
  return slug;
}

module.exports = { toCustomerSlug };
