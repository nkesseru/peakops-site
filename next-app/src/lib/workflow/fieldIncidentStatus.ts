/**
 * Canonical workflow-state model for the **field incident overview**.
 *
 * Scope: this module describes what "arrived / evidence captured / notes saved /
 * submitted" mean at the *incident* level. It is the single source of truth that
 * the field page (`app/incidents/[incidentId]/IncidentClient.tsx`) uses to drive:
 *
 *   - the readiness checklist in NextBestAction
 *   - the primary CTA label ("Mark arrived" → "Add evidence" → …)
 *   - the flow-stage bar (Arrive / Evidence / Notes / Submit / Review / Done)
 *   - the timing card
 *   - the bottom-dock step tiles
 *
 * Intentionally *separate* from the supervisor review model. Supervisor
 * readiness is computed in `app/incidents/[incidentId]/review/ReviewClient.tsx`
 * from job-level facts:
 *   - `reviewableJobs`: `status ∈ {complete, review}` AND linked evidence ≥ 1
 *   - `canApproveNow`: selected job ready state + linked evidence ≥ 1 + not
 *     already approved
 * Do not conflate the two. A field user can be "ready" at the incident level
 * (arrived + any evidence + notes) while zero jobs are yet ready for supervisor
 * review. Conversely a supervisor can have a reviewable job without the field
 * user having submitted the incident.
 *
 * All rules below operate only on incident-level inputs. No job state is read.
 */

export type FieldIncidentInput = {
  /** Timeline docs from getTimelineEventsV1. */
  timeline?: readonly any[];
  /** Evidence docs from listEvidenceLocker. */
  evidence?: readonly any[];
  /** Sticky localStorage fallback — only used when timeline is genuinely missing. */
  notesSavedLocal?: boolean;
  /** Sticky localStorage fallback — only used when timeline is genuinely missing. */
  arrivedLocal?: boolean;
  /**
   * Computed elsewhere from jobs[]. Only used to decide "review" vs "done".
   * Field overview does not own job approval logic; that is supervisor territory.
   */
  allJobsApproved?: boolean;
};

export type FieldIncidentStage =
  | "arrive"
  | "evidence"
  | "notes"
  | "submit"
  | "review"
  | "done";

export type FieldIncidentStatus = {
  /** Has the field user marked arrived? (Timeline event OR session signal OR sticky OR implicit evidence.) */
  hasArrival: boolean;
  /** Has the field user captured ANY evidence on the incident? */
  hasEvidence: boolean;
  /** Has the field user saved notes? (Timeline event OR sticky.) */
  hasNotes: boolean;
  /** Has the field user submitted the session for review? (Timeline event.) */
  hasSubmitted: boolean;

  /** Real (non-placeholder) evidence doc count. */
  evidenceCount: number;

  /** Unix seconds for each milestone, when available. Null when unknown. */
  arrivalSec: number | null;
  notesSec: number | null;
  evidenceLatestSec: number | null;

  /** Monotonic pipeline stage. The field primary CTA reads from this. */
  currentStage: FieldIncidentStage;

  /**
   * Any session-started signal on the timeline. Exposed because
   * NextBestAction currently takes it as a separate prop; prefer `hasArrival`
   * for all new logic.
   */
  hasSessionTimeline: boolean;
};

function latestSecForType(timeline: readonly any[], type: string): number | null {
  let best = 0;
  for (const t of timeline) {
    if (String(t?.type || "") !== type) continue;
    const sec = Number(t?.occurredAt?._seconds || 0);
    if (sec > best) best = sec;
  }
  return best ? best : null;
}

function isRealEvidenceDoc(ev: any): boolean {
  const path = String(ev?.file?.storagePath || "").trim();
  if (!path) return false;
  if (path.includes("demo_placeholder")) return false;
  return true;
}

/**
 * Pure, deterministic derivation. Same input → same output. No side effects.
 *
 * ## Rules
 *
 * **Arrive done** when any of:
 *   1. Timeline has a `FIELD_ARRIVED` event.
 *   2. Timeline has any session-started signal (`SESSION_STARTED`, `FIELD_ARRIVED`, `EVIDENCE_ADDED`).
 *   3. `arrivedLocal` sticky flag is set (localStorage rescue for eventual consistency / offline).
 *   4. There is at least one real evidence doc (you cannot upload without a session).
 *
 * **Evidence done** when there is **any** real evidence doc on the incident.
 * (Previously the field page required ≥ 4 items, which was an out-of-date MVP
 * heuristic. The incident-level rule is "at least one".)
 *
 * **Notes done** when any of:
 *   1. Timeline has a `NOTES_SAVED` event.
 *   2. `notesSavedLocal` sticky flag is set.
 *
 * **Submit ready** when arrival + (evidence OR notes). Computed by the caller,
 * not by this module; we just surface `hasSubmitted` so the caller knows if
 * the submit has *already* happened.
 *
 * **Current stage** progresses monotonically:
 *   `arrive → evidence → notes → submit → review → done`
 * and only advances — never regresses — for a given canonical input.
 */
export function deriveFieldIncidentStatus(input: FieldIncidentInput): FieldIncidentStatus {
  const timeline: readonly any[] = Array.isArray(input.timeline) ? input.timeline : [];
  const evidence: readonly any[] = Array.isArray(input.evidence) ? input.evidence : [];
  const notesSavedLocal = !!input.notesSavedLocal;
  const arrivedLocal = !!input.arrivedLocal;
  const allJobsApproved = !!input.allJobsApproved;

  const realEvidence = evidence.filter(isRealEvidenceDoc);
  const evidenceCount = realEvidence.length;

  const arrivalSec = latestSecForType(timeline, "FIELD_ARRIVED");
  const notesSec = latestSecForType(timeline, "NOTES_SAVED");
  const evidenceSecFromTimeline = latestSecForType(timeline, "EVIDENCE_ADDED");
  const evidenceSecFromDocs = (() => {
    for (const ev of realEvidence) {
      const s = Number(ev?.storedAt?._seconds || ev?.createdAt?._seconds || 0);
      if (s) return s;
    }
    return 0;
  })();
  const evidenceLatestSec = evidenceSecFromTimeline || (evidenceSecFromDocs ? evidenceSecFromDocs : null);

  const hasSessionTimeline = timeline.some((t: any) =>
    String(t?.type) === "SESSION_STARTED" ||
    String(t?.type) === "FIELD_ARRIVED" ||
    String(t?.type) === "EVIDENCE_ADDED"
  );

  const hasArrival =
    !!arrivalSec ||
    hasSessionTimeline ||
    arrivedLocal ||
    evidenceCount > 0;

  const hasEvidence = evidenceCount > 0;

  const hasNotes = !!notesSec || notesSavedLocal;

  const hasSubmitted = timeline.some((t: any) =>
    String(t?.type || "").trim().toLowerCase() === "field_submitted"
  );

  // Stage ordering is monotonic. Once any of the *later* gates fires, we
  // never fall back to an earlier stage, even if earlier signals are absent.
  // This fixes the case where a submitted incident briefly had notesSec=null
  // (backend event not yet read) and the stage bar lit up "Notes" again.
  let currentStage: FieldIncidentStage;
  if (allJobsApproved && hasSubmitted) currentStage = "done";
  else if (hasSubmitted) currentStage = "review";
  else if (!hasArrival) currentStage = "arrive";
  else if (!hasEvidence && !hasNotes) currentStage = "evidence";
  else if (!hasNotes) currentStage = "notes";
  else currentStage = "submit";

  return {
    hasArrival,
    hasEvidence,
    hasNotes,
    hasSubmitted,
    evidenceCount,
    arrivalSec,
    notesSec,
    evidenceLatestSec,
    currentStage,
    hasSessionTimeline,
  };
}
