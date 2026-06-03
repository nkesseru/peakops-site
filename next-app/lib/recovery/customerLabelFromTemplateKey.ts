// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Client-side helper to derive a human-readable customer label from
// the templateKey stored on a Recovery Case. The backend snapshot
// stores templateKey but not customerLabel (yet — Phase 1 follow-up
// could denorm it). For MVP, we extract the slug after "__" and
// humanize it.
//
// Conventions established by createIncidentV1 (PR 91):
//   templateKey = `${archetype}__${customerSlug}` (customer-specific)
//   templateKey = `${archetype}` (org-wide, no double-underscore)
//
// Examples:
//   "fiber_splice_verification__comcast-restoration" → "Comcast Restoration"
//   "fiber_splice_verification__city-of-riverbend"   → "City Of Riverbend"
//   "fiber_splice_verification"                       → ""
//   "" / null / undefined                             → ""

export function customerLabelFromTemplateKey(templateKey?: string | null): string {
  const key = String(templateKey || "").trim();
  if (!key) return "";
  const idx = key.indexOf("__");
  if (idx < 0) return ""; // org-wide template; no customer
  const slug = key.slice(idx + 2);
  if (!slug) return "";
  return slug
    .split("-")
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
