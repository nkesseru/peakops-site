/**
 * PEAKOPS_DEMO_HYGIENE_V1 (2026-06-18)
 *
 * Operator-queue filter: returns true when an incident looks like
 * demo/smoke/test trash that should NOT clutter the dashboard,
 * records list, or other operator-facing queues. Used as a
 * client-side display filter — no data writes, no schema changes,
 * fully reversible by reverting the call sites.
 *
 * Distinct from `looksRealForHero` in app/dashboard/page.tsx:
 *   - looksRealForHero is a HERO-card filter: must look polished
 *     enough to feature on a single hero card (filters more
 *     aggressively).
 *   - isDemoArtifact is a QUEUE filter: hides obvious smoke trash
 *     from list views (filters less aggressively).
 *
 * The two helpers may share patterns but evolve independently.
 *
 * Patterns excluded from queues:
 *   - title starts with E2E, SMOKE, PR{N}, dummy
 *   - title contains "smoke test" or "internal QA" or "seed data"
 *   - title is missing / "Untitled incident"
 *   - incidentId starts with e2e_, case_e2e_, dummy
 *
 * Protected demo records are ALWAYS allowed through, even if their
 * id/title would otherwise match a pattern. Maintain this allow-list
 * conservatively — every entry is a record that must remain visible
 * in customer-facing demos.
 */

const PROTECTED_DEMO_IDS = new Set<string>([
  // Dashboard hero target — "Fiber splice verification — Internal Alpha Test"
  "inc_20260508_121451_acnew0",
  // Northgate Mutual Telecom — staged demo for Recovery flow
  "demo_20260616T122606Z_5ax3",
]);

export function isDemoArtifact(incident: {
  incidentId?: string | null;
  title?: string | null;
}): boolean {
  const id = String(incident?.incidentId || "").trim();
  if (id && PROTECTED_DEMO_IDS.has(id)) return false;

  // Untitled / empty title is itself a demo-trash signal.
  const t = String(incident?.title || "").trim();
  if (!t) return true;

  // Title pattern checks — case-insensitive.
  if (/^e2e[ _·-]/i.test(t)) return true;
  if (/^smoke[ _·-]/i.test(t)) return true;
  if (/smoke[ _-]?test/i.test(t)) return true;
  if (/^pr\d+[a-z]?[ _·-]/i.test(t)) return true;
  if (/^dummy[ _-]?/i.test(t)) return true;
  if (/internal[ _]+qa\b/i.test(t)) return true;
  if (/\bseed[ _]+data\b/i.test(t)) return true;
  if (/^untitled\b/i.test(t)) return true;

  // ID pattern checks — for records whose title happens to look real
  // but whose ID is a known smoke prefix.
  if (id) {
    if (/^e2e_/i.test(id)) return true;
    if (/^case_e2e_/i.test(id)) return true;
    if (/^dummy[-_]/i.test(id)) return true;
  }

  return false;
}
