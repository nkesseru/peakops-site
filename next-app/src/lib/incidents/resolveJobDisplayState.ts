/**
 * PEAKOPS_CANONICAL_STATE_V1 (2026-05-05)
 *
 * Single source of truth for the user-facing job lifecycle state.
 *
 * Every surface that shows a status pill, a CTA based on lifecycle
 * position, a stepper position, or a list filter MUST derive its
 * state from `resolveJobDisplayState(input)`. Earlier passes had
 * each surface derive its own variant of "what state is this job
 * in?", and the result was a buyer-trust-killing contradiction:
 * one job could simultaneously appear "Awaiting Review" on the
 * jobs list, "Approved" on the field page, and "Closed" on the
 * report. This resolver eliminates that.
 *
 * Priority order (highest to lowest — first match wins):
 *
 *   1. Closed              — job is finalized; report-ready.
 *   2. Approved            — supervisor signed off; not yet closed.
 *   3. Sent Back           — supervisor rejected; field needs to redo.
 *   4. Awaiting Supervisor Review
 *                          — field submitted; supervisor hasn't acted.
 *   5. In Progress         — work started: arrived, photos, or notes.
 *   6. Open                — default; nothing has happened yet.
 *
 * Closed beats everything else (a stale `submittedAt` on a closed
 * record won't make it look pending). Approved beats Awaiting
 * Review (a stale `submittedAt` on an approved record won't make
 * it look unreviewed). Sent Back outranks Awaiting Review (a
 * job that was bounced back is not "awaiting" anything from the
 * supervisor — the field crew owes the next move).
 */

export type JobDisplayState =
  | "Open"
  | "In Progress"
  | "Awaiting Supervisor Review"
  | "Approved"
  | "Closed"
  | "Sent Back";

/**
 * Permissive input shape — the resolver tolerates whichever subset
 * of fields the caller actually has loaded. Missing fields are
 * treated as not-set, never as a hard signal.
 *
 * Backend writers use a few different field names for the same
 * lifecycle event (e.g. closedAt vs status="closed"); the resolver
 * accepts all of them and picks the most authoritative.
 */
export type JobDisplayStateInput = {
  // Raw status string written by the backend lifecycle calls.
  // Known values seen in the wild: open, in_progress, submitted,
  // awaiting_review, in_review, review, approved, locked, rejected,
  // sent_back, closed.
  status?: unknown;

  // Per-task review status (jobs subcollection). When this is set,
  // it usually beats the parent `status` field for review-side
  // surfaces. Known values: review, approved, rejected,
  // revision_requested.
  reviewStatus?: unknown;

  // Lifecycle timestamps. Any truthy timestamp is treated as the
  // event having happened — we don't read the actual value.
  closedAt?: unknown;
  approvedAt?: unknown;
  submittedAt?: unknown;
  workStartedAt?: unknown;
  rejectedAt?: unknown;
  sentBackAt?: unknown;

  // Explicit booleans, when surfaces have them pre-computed (e.g.
  // the field page knows hasArrival / hasSubmitted from the
  // timeline; the export pipeline knows allWorkItemsApproved).
  supervisorApproved?: boolean;
  hasArrival?: boolean;
  hasSubmitted?: boolean;
  allTasksApproved?: boolean;
  anyRejected?: boolean;

  // Counters that power the In Progress fallback.
  evidenceCount?: number;
  photosCount?: number;
  taskCount?: number;
  approvedTaskCount?: number;
  completedTaskCount?: number;

  // Notes signal — any of these truthy means the job has notes.
  hasNotes?: boolean;
  notesSummary?: { saved?: boolean; text?: string } | null | undefined;
};

function isTruthyTimestamp(v: unknown): boolean {
  if (!v) return false;
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "object") {
    const seconds = (v as { _seconds?: unknown })._seconds;
    if (typeof seconds === "number" && seconds > 0) return true;
    const toDate = (v as { toDate?: unknown }).toDate;
    if (typeof toDate === "function") return true;
  }
  return false;
}

function normalizeStatus(raw: unknown): string {
  return String(raw || "").trim().toLowerCase();
}

export function resolveJobDisplayState(input: JobDisplayStateInput | null | undefined): JobDisplayState {
  const i = input || {};
  const status = normalizeStatus(i.status);
  const review = normalizeStatus(i.reviewStatus);

  // 1. Closed. Final state — beats every other signal. A stale
  //    submittedAt or reviewStatus must not surface here.
  if (status === "closed" || isTruthyTimestamp(i.closedAt)) {
    return "Closed";
  }

  // 2. Approved. Supervisor sign-off. Beats "submitted" / "awaiting"
  //    so a record with a stale submittedAt and a fresh approvedAt
  //    reads as Approved, not Awaiting Review.
  if (
    status === "approved" ||
    status === "locked" ||
    review === "approved" ||
    isTruthyTimestamp(i.approvedAt) ||
    i.supervisorApproved === true ||
    i.allTasksApproved === true
  ) {
    return "Approved";
  }

  // 3. Sent Back. The supervisor reviewed and rejected. Outranks
  //    Awaiting Review (the supervisor is no longer the bottleneck —
  //    the field crew is). Stays above In Progress so a rejected
  //    record with photos doesn't read as fresh work.
  if (
    status === "rejected" ||
    status === "sent_back" ||
    review === "rejected" ||
    review === "revision_requested" ||
    i.anyRejected === true ||
    isTruthyTimestamp(i.rejectedAt) ||
    isTruthyTimestamp(i.sentBackAt)
  ) {
    return "Sent Back";
  }

  // 4. Awaiting Supervisor Review. Field submitted; supervisor
  //    hasn't acted. Backend writes any of: submitted,
  //    awaiting_review, in_review, review.
  if (
    status === "submitted" ||
    status === "awaiting_review" ||
    status === "in_review" ||
    status === "review" ||
    review === "review" ||
    isTruthyTimestamp(i.submittedAt) ||
    i.hasSubmitted === true
  ) {
    return "Awaiting Supervisor Review";
  }

  // 5. In Progress. Work has actually started — the field crew
  //    arrived, captured a photo, or saved a note. We deliberately
  //    accept a positive `status === "in_progress"` here, but the
  //    counters below are the more reliable signal: the lifecycle
  //    sometimes lags the actual work.
  const hasNotes =
    i.hasNotes === true ||
    !!i.notesSummary?.saved ||
    !!String(i.notesSummary?.text || "").trim();
  const photoCount = Number(i.photosCount ?? i.evidenceCount ?? 0);
  if (
    status === "in_progress" ||
    isTruthyTimestamp(i.workStartedAt) ||
    i.hasArrival === true ||
    photoCount > 0 ||
    hasNotes
  ) {
    return "In Progress";
  }

  // 6. Open — nothing has happened yet.
  return "Open";
}

/**
 * Lowercase canonical key for chip/filter URL params and CSS
 * tone selection. Returns the same buckets the Jobs page chip
 * strip uses.
 */
export type JobDisplayStateKey =
  | "open"
  | "in_progress"
  | "awaiting_review"
  | "approved"
  | "closed"
  | "sent_back";

const STATE_TO_KEY: Record<JobDisplayState, JobDisplayStateKey> = {
  Open: "open",
  "In Progress": "in_progress",
  "Awaiting Supervisor Review": "awaiting_review",
  Approved: "approved",
  Closed: "closed",
  "Sent Back": "sent_back",
};

export function jobDisplayStateKey(state: JobDisplayState): JobDisplayStateKey {
  return STATE_TO_KEY[state];
}

/**
 * Tone class for the canonical pill. Matches the green/amber/red/
 * gray discipline established in the prior visual pass.
 */
export type JobDisplayStateTone = "green" | "amber" | "red" | "neutral";
const STATE_TO_TONE: Record<JobDisplayState, JobDisplayStateTone> = {
  Closed: "green",
  Approved: "green",
  "Awaiting Supervisor Review": "amber",
  "In Progress": "neutral",
  Open: "neutral",
  "Sent Back": "red",
};
export function jobDisplayStateTone(state: JobDisplayState): JobDisplayStateTone {
  return STATE_TO_TONE[state];
}

/**
 * Mapping from canonical state → FlowStageBar stage key. The
 * field-page stepper is informational; this mapping ensures the
 * stepper position is always consistent with the header pill.
 *
 * "Approved" / "Sent Back" both surface inside the supervisor-side
 * review window, so they both map to "submit done, awaiting closure"
 * — the stepper shows Send to Supervisor as complete, Closed as
 * pending.
 */
export type FlowStageKey = "arrive" | "evidence" | "notes" | "submit" | "review" | "done";
// PEAKOPS_FLOWBAR_STAGE_MAP_V2 (2026-05-05)
// Sent Back returns the work to the field crew — they're back at
// the Capture/Notes phase, not still "in review". Mapping it to
// "evidence" lights the Capture step gold so the field crew sees
// where the active work is. Awaiting Review and Approved both stay
// at "review" — the field is done, the supervisor is the bottleneck.
const STATE_TO_STAGE: Record<JobDisplayState, FlowStageKey> = {
  Open: "arrive",
  "In Progress": "evidence",
  "Sent Back": "evidence",
  "Awaiting Supervisor Review": "review",
  Approved: "review",
  Closed: "done",
};
export function jobDisplayStateToStage(state: JobDisplayState): FlowStageKey {
  return STATE_TO_STAGE[state];
}

/**
 * PEAKOPS_UI_STATE_V1 (2026-05-05)
 *
 * Single page-level UI state object. Pages compute this once from
 * the loaded job/incident data, then drive every CTA / pill / step /
 * banner from it. Capabilities are pure functions of `displayState` —
 * if a page mutates one of these flags independently the contract is
 * broken; treat the object as the only source of truth.
 *
 * Capability flags:
 *   canAddPhotos    — Add Photos / Capture is allowed (Open / In Progress)
 *   canAddNotes     — Add Notes is allowed (Open / In Progress / Sent Back)
 *   canSendToSupervisor — Send to Supervisor is the next CTA (In Progress)
 *   canApprove      — Supervisor approve action is allowed (Awaiting Review)
 *   canSendBack     — Supervisor send-back action is allowed (Awaiting Review)
 *   canClose        — Supervisor close action is allowed (Approved)
 *   canOpenReport   — Report is downloadable / openable (Closed)
 *   isReadOnly      — No further field actions allowed (Closed)
 *
 * Primary-CTA hint:
 *   "start_job" | "add_photos" | "add_notes" | "send_to_supervisor"
 *   | "open_review" | "approve_job" | "close_job" | "open_report" | "none"
 */
export type JobCtaKey =
  | "start_job"
  | "add_photos"
  | "add_notes"
  | "send_to_supervisor"
  | "open_review"
  | "approve_job"
  | "close_job"
  | "open_report"
  | "none";

export type JobUiState = {
  displayState: JobDisplayState;
  stage: FlowStageKey;
  tone: JobDisplayStateTone;
  key: JobDisplayStateKey;
  primaryCta: JobCtaKey;
  canAddPhotos: boolean;
  canAddNotes: boolean;
  canSendToSupervisor: boolean;
  canApprove: boolean;
  canSendBack: boolean;
  canClose: boolean;
  canOpenReport: boolean;
  isReadOnly: boolean;
};

const PRIMARY_CTA_BY_STATE: Record<JobDisplayState, JobCtaKey> = {
  Open: "start_job",
  "In Progress": "send_to_supervisor",
  "Awaiting Supervisor Review": "open_review",
  "Sent Back": "add_photos",
  Approved: "close_job",
  Closed: "open_report",
};

/**
 * PEAKOPS_VIEW_MODEL_ALIASES_V1 (2026-05-05)
 *
 * Named aliases for the four canonical surfaces. Each builder is the
 * exact same `buildJobUiState` under the hood — the per-surface name
 * exists so a future change can specialize one surface without
 * leaking through the others, and so a code-search for
 * `buildReviewUiState` lands you on the Review page's view-model
 * call site.
 */
export const buildJobsListUiState = (input: JobDisplayStateInput | null | undefined): JobUiState =>
  buildJobUiState(input);
export const buildFieldJobUiState = (input: JobDisplayStateInput | null | undefined): JobUiState =>
  buildJobUiState(input);
export const buildReviewUiState = (input: JobDisplayStateInput | null | undefined): JobUiState =>
  buildJobUiState(input);
export const buildReportUiState = (input: JobDisplayStateInput | null | undefined): JobUiState =>
  buildJobUiState(input);

export function buildJobUiState(input: JobDisplayStateInput | null | undefined): JobUiState {
  const displayState = resolveJobDisplayState(input);
  const isClosed = displayState === "Closed";
  const isApproved = displayState === "Approved";
  const isAwaiting = displayState === "Awaiting Supervisor Review";
  const isSentBack = displayState === "Sent Back";
  const isInProgress = displayState === "In Progress";
  const isOpen = displayState === "Open";

  return {
    displayState,
    stage: jobDisplayStateToStage(displayState),
    tone: jobDisplayStateTone(displayState),
    key: jobDisplayStateKey(displayState),
    primaryCta: PRIMARY_CTA_BY_STATE[displayState],
    // Field actions: never allowed once supervisor took the work or
    // closed it. Sent-Back jobs are back in the field's hands.
    canAddPhotos: isOpen || isInProgress || isSentBack,
    canAddNotes: isOpen || isInProgress || isSentBack,
    canSendToSupervisor: isInProgress,
    // Supervisor actions: only meaningful while the supervisor is
    // the bottleneck (Awaiting Review).
    canApprove: isAwaiting,
    canSendBack: isAwaiting,
    // Close: post-approval, pre-close.
    canClose: isApproved,
    // Report: customer-readable surface only after close. Approved
    // and earlier states do not count — there's no audit-ready
    // packet until close fires.
    canOpenReport: isClosed,
    isReadOnly: isClosed,
  };
}

