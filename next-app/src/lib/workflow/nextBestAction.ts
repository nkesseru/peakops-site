/**
 * PEAKOPS_NEXT_BEST_ACTION_V2 (2026-04-27)
 *
 * Single source of workflow truth for the Next Best Action card.
 * Pure function: takes a snapshot of derived state, returns the
 * canonical action the user should take next.
 *
 * STRICT PRIORITY ORDER (top down — first matching rule wins):
 *
 *   1. !hasArrival              → "Mark arrived"
 *   2. evidenceCount === 0      → "Add Evidence"
 *   3. workItemCount === 0      → "Create Task"
 *   4. unassignedEvidence > 0   → "Attach Evidence"  [BLOCKER]
 *   5. !anyWorkItemComplete     → "Finish Task"
 *   6. !hasSubmitted            → "Send to Supervisor"
 *   7. hasSubmitted (not approved/closed)
 *                               → supervisor: "Review Work"
 *                               → field:      waiting status pill
 *   8. allWorkItemsApproved     → "Close Incident"
 *   9. isClosed && !packetReady → "Generate Report"
 *  10. isClosed && packetReady  → "Download Report"
 *
 * RULE 4 IS A HARD BLOCKER. Any time `unassignedEvidenceCount > 0`,
 * the action is "Attach Evidence" — even if the incident has been
 * closed, approved, submitted, or had its tasks completed by a
 * concurrent edit. This protects the export's "all evidence attached"
 * invariant from racing with the UI.
 *
 * Closed-state precedence: rules 1-3 only fire when the incident is
 * still open. Once closed, rules 9/10 are the natural terminal state.
 * Rule 4 still wins over closed if data is inconsistent — that's the
 * defensive contract.
 *
 * SAFEGUARD: if no rule matches, the helper returns the BLOCKER state
 * with a console.warn, because that's the only state that can never
 * cause data loss. (Reaching the fallback means our state derivation
 * has a gap; surfacing it loudly is preferable to silently advancing.)
 */

export type NextActionViewContext = "incident" | "review" | "summary";

export type NextActionInput = {
  hasArrival: boolean;
  evidenceCount: number;
  unassignedEvidenceCount: number;
  workItemCount: number;
  anyWorkItemComplete: boolean;
  allWorkItemsApproved: boolean;
  hasReviewableWorkItem: boolean;
  hasSubmitted: boolean;
  isClosed: boolean;
  packetReady: boolean;
  /** Lowercased role from custom claims, e.g. "supervisor", "admin", "field". */
  role: string;
  /** Currently-selected task id (for the Finish Task button). */
  currentWorkItemId: string;
  /**
   * Where the NBA is rendered. Lets the helper produce review-specific
   * copy ("Approve & Lock" + "Send Back") instead of generic "Review
   * Work" when the user is already on /review.
   */
  viewContext?: NextActionViewContext;
  /**
   * PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29)
   * Has the field tech saved at least one note for this incident?
   */
  hasNotes?: boolean;
  /**
   * Has the field tech *intentionally* declined to add a note ("No
   * note needed — photos tell the story")? Treated as equivalent to
   * hasNotes for advancement purposes; a missing-or-false value means
   * the user has not yet made the choice.
   */
  notesBypassed?: boolean;
};

/**
 * Discriminated action that a host component binds to its own handler.
 * Splitting this from the copy keeps the helper pure (no React, no
 * router, no toast).
 */
export type NextActionKey =
  | "mark_arrived"
  | "add_evidence"
  | "create_work_item"
  | "attach_evidence"
  | "finish_work_item"
  | "add_notes"
  | "bypass_notes"
  | "submit"
  | "review"
  | "approve_work"
  | "send_back"
  | "close"
  | "open_report"
  | "download_report"
  | "back_to_incident"
  | "none";

export type NextAction = {
  /** Unique state id for telemetry / debugging. */
  state:
    | "mark_arrived"
    | "add_evidence"
    | "create_work_item"
    | "attach_evidence_blocker"
    | "finish_work_item"
    | "notes_checkpoint"
    | "submit"
    | "review"
    | "approve_work"
    | "waiting"
    | "close"
    | "generate_report"
    | "download_report"
    | "fallback_blocker";
  title: string;
  helper: string;
  buttonLabel: string;
  /** Discriminator the host component binds to a handler. */
  primaryAction: NextActionKey;
  enabled: boolean;
  tone: "primary" | "muted" | "success";
  secondaryLabel?: string;
  secondaryAction?: NextActionKey;
};

const SUPERVISOR_ROLES = new Set(["supervisor", "admin"]);

export function deriveNextAction(input: NextActionInput): NextAction {
  const {
    hasArrival,
    evidenceCount,
    unassignedEvidenceCount,
    workItemCount,
    anyWorkItemComplete,
    allWorkItemsApproved,
    hasReviewableWorkItem,
    hasSubmitted,
    isClosed,
    packetReady,
    role,
    currentWorkItemId,
  } = input;

  const isSupervisor = SUPERVISOR_ROLES.has(role);
  const onReviewPage = input.viewContext === "review";

  // 1. Not arrived (only if the incident is still open).
  if (!isClosed && !hasArrival) {
    return {
      state: "mark_arrived",
      title: "Start the job",
      helper: "Check in on site before adding photos or notes.",
      buttonLabel: "Start Job",
      primaryAction: "mark_arrived",
      enabled: true,
      tone: "primary",
    };
  }

  // 2. No evidence yet.
  if (!isClosed && evidenceCount === 0) {
    return {
      state: "add_evidence",
      title: "Add photos",
      helper: "Capture photos that show the work, issue, or site condition.",
      buttonLabel: "Add Photos",
      primaryAction: "add_evidence",
      enabled: true,
      tone: "primary",
    };
  }

  // 3. Evidence exists but no task to group it under.
  if (!isClosed && evidenceCount > 0 && workItemCount === 0) {
    return {
      state: "create_work_item",
      title: "Create a task for this work",
      helper: "Group the photos under the work being documented.",
      buttonLabel: "Create Task",
      primaryAction: "create_work_item",
      enabled: true,
      tone: "primary",
      secondaryLabel: "Add more photos",
      secondaryAction: "add_evidence",
    };
  }

  // 4. BLOCKER — unassigned evidence MUST be resolved before anything
  //    forward (finish, submit, review, close, generate, download).
  //    Evaluated before the closed/approved/submitted branches so a
  //    racing data state can't bypass the gate.
  if (unassignedEvidenceCount > 0) {
    return {
      state: "attach_evidence_blocker",
      title: "Attach photos to a task",
      helper: "Photos must be attached to a task before this can be reviewed.",
      buttonLabel: "Attach Photos",
      primaryAction: "attach_evidence",
      enabled: true,
      tone: "primary",
      secondaryLabel: "Add more photos",
      secondaryAction: "add_evidence",
    };
  }

  // 9 + 10. Closed terminal states (rule 4 already short-circuited if
  //         unassigned evidence exists, so reaching here is consistent).
  if (isClosed) {
    if (packetReady) {
      // Download is read-only and safe for any role, so all roles get
      // the same affordance once the report exists.
      return {
        state: "download_report",
        title: "Report ready",
        helper: "The job report is ready to download.",
        buttonLabel: "Open Report",
        primaryAction: "download_report",
        enabled: true,
        tone: "success",
        secondaryLabel: "Back to Job",
        secondaryAction: "back_to_incident",
      };
    }
    // PEAKOPS_NBA_FIELD_NO_GENERATE_V1 (2026-04-28)
    // Generating the report is a supervisor-finalization step. Field
    // users must not see a Generate Report button before the
    // supervisor completes the flow — show a passive "Waiting for
    // report" state instead. Supervisors and admins keep the action.
    if (!isSupervisor) {
      return {
        state: "waiting",
        title: "Waiting for the report",
        helper: "The job is closed. Your supervisor will finalize the report.",
        buttonLabel: "Waiting",
        primaryAction: "none",
        enabled: false,
        tone: "muted",
      };
    }
    return {
      state: "generate_report",
      title: "Generate the report",
      helper: "Create the final audit-ready job report.",
      buttonLabel: "Generate Report",
      primaryAction: "open_report",
      enabled: true,
      tone: "primary",
    };
  }

  // 8. All tasks approved (incident is open). Closing is a supervisor
  //    action — field users see a passive "Waiting for supervisor".
  if (allWorkItemsApproved) {
    if (!isSupervisor) {
      return {
        state: "waiting",
        title: "Waiting for supervisor",
        helper: "All tasks are approved. Your supervisor will close the job.",
        buttonLabel: "Waiting",
        primaryAction: "none",
        enabled: false,
        tone: "muted",
      };
    }
    return {
      state: "close",
      title: "Close the job",
      helper: "All tasks have been approved. Close the job to prepare the report.",
      buttonLabel: "Close Job",
      primaryAction: "close",
      enabled: true,
      tone: "primary",
    };
  }

  // 7. Submitted — supervisor reviews, field waits.
  if (hasSubmitted) {
    if (isSupervisor && hasReviewableWorkItem) {
      // PEAKOPS_NBA_REVIEW_CONTEXT_V1 (2026-04-28)
      // When the supervisor is already on /review, expand the generic
      // "Review Work" CTA into the actual two-button decision they need
      // to make: Approve & Lock (primary) or Send Back (secondary).
      if (onReviewPage) {
        return {
          state: "approve_work",
          title: "Approve the work",
          helper: "Lock the completed job so it can be closed.",
          buttonLabel: "Approve Job",
          primaryAction: "approve_work",
          enabled: true,
          tone: "primary",
          secondaryLabel: "Send back",
          secondaryAction: "send_back",
        };
      }
      return {
        state: "review",
        title: "Supervisor review",
        helper: "Approve the completed job or send it back for updates.",
        buttonLabel: "Open Supervisor Review",
        primaryAction: "review",
        enabled: true,
        tone: "primary",
      };
    }
    return {
      state: "waiting",
      title: "Sent to supervisor",
      helper: "Your job has been sent for review. No action is needed right now.",
      buttonLabel: "Sent",
      primaryAction: "none",
      enabled: false,
      tone: "muted",
    };
  }

  // 6a. PEAKOPS_NOTES_CHECKPOINT_V1 (2026-04-29) — A task is complete
  //     and photos exist, but the field tech has not yet either saved a
  //     note OR intentionally bypassed the note step. Force a deliberate
  //     decision before Submit unlocks. This prevents accidental
  //     submission of an incident with no narrative AND lets a
  //     photo-only incident move forward as long as the user
  //     acknowledges that's what they meant to do.
  if (anyWorkItemComplete && !input.hasNotes && !input.notesBypassed) {
    return {
      state: "notes_checkpoint",
      title: "Add a note or skip",
      helper:
        "Tell the supervisor what happened, or confirm the photos are enough.",
      buttonLabel: "Add Note",
      primaryAction: "add_notes",
      enabled: true,
      tone: "primary",
      secondaryLabel: "No note needed",
      secondaryAction: "bypass_notes",
    };
  }

  // 6b. A task is complete and the notes checkpoint has been satisfied.
  if (anyWorkItemComplete) {
    return {
      state: "submit",
      title: "Send to supervisor",
      helper: "Everything is ready for review.",
      buttonLabel: "Send to Supervisor",
      primaryAction: "submit",
      enabled: true,
      tone: "primary",
    };
  }

  // 5. Work items exist, evidence is fully attached, but nothing is
  //    complete yet.
  if (workItemCount > 0) {
    const ready = !!currentWorkItemId;
    return {
      state: "finish_work_item",
      title: "Finish the task",
      helper: ready
        ? "Mark this task complete so it can be sent for review."
        : "Choose a task first — open Tasks, pick the active one, then come back.",
      buttonLabel: "Finish Task",
      primaryAction: "finish_work_item",
      enabled: ready,
      tone: "primary",
      secondaryLabel: ready ? "Open Tasks" : "Choose Task",
      secondaryAction: "create_work_item",
    };
  }

  // SAFEGUARD: unreachable in well-formed state. Fallback to the safe
  //            blocker so the user can never advance past an invariant
  //            we don't understand. Log loudly so a human investigates.
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    // eslint-disable-next-line no-console
    console.warn("[NextBestAction] no rule matched; falling back to attach-evidence blocker", input);
  }
  return {
    state: "fallback_blocker",
    title: "Attach photos to a task",
    helper: "We couldn't determine the next step automatically. Attach photos to a task to keep the workflow moving.",
    buttonLabel: "Attach Photos",
    primaryAction: "attach_evidence",
    enabled: true,
    tone: "primary",
  };
}
