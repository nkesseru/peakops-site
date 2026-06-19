/**
 * PEAKOPS_DISPLAY_INCIDENT_TITLE_V2 (2026-04-30)
 *
 * Single source of truth for the customer-facing incident name. Used
 * across the dashboard, IncidentClient, ReviewClient, SummaryClient,
 * and AddEvidenceClient so all surfaces render the same label.
 *
 * Resolution order:
 *   1. incident.title       (set on createIncidentV1 / by the operator)
 *   2. incident.name        (alternate field on legacy records)
 *   3. incident.description (long-form fallback when no title was set)
 *   4. first task title     (often the most descriptive operator-set
 *                            label when no incident-level title exists)
 *   5. "Untitled incident"  (final fallback — never surface raw IDs as
 *                            the primary label)
 *
 * Raw incidentId is reserved for tooltips / dev-only sub-text — never
 * the headline.
 */

type LooseIncident =
  | { title?: unknown; name?: unknown; description?: unknown }
  | null
  | undefined;
type LooseTask = { title?: unknown } | null | undefined;

function trim(v: unknown): string {
  return String(v || "").trim();
}

export function displayIncidentTitle(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _incidentId: string | null | undefined,
  incident?: LooseIncident,
  tasks?: ReadonlyArray<LooseTask>,
): string {
  const t1 = trim((incident as any)?.title);
  if (t1) return t1;

  const t2 = trim((incident as any)?.name);
  if (t2) return t2;

  const t3 = trim((incident as any)?.description);
  if (t3) {
    // Trim long descriptions so they fit a single-line label.
    return t3.length > 80 ? t3.slice(0, 78).trimEnd() + "…" : t3;
  }

  const arr = Array.isArray(tasks) ? tasks : [];
  for (const t of arr) {
    const tt = trim((t as any)?.title);
    if (tt) return tt;
  }

  return "Untitled incident";
}
