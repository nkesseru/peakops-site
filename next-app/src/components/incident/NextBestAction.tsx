"use client";

/**
 * PEAKOPS_NEXT_BEST_ACTION_V2 (PR 85 — open-state cockpit reframing)
 *
 * Visible language convergence pass. Replaces "Capture evidence" /
 * "Add evidence" / "Submit session" wording with the proof / acceptance
 * vocabulary established by PR 71/82/84. No layout rebuild, no logic
 * change. Same state machine, same boolean predicates, same callback
 * shape.
 *
 * v2 additions:
 *   - archetypeLabel?: string — when present (caller threads the
 *     curated archetype label through), a quiet line appears under
 *     the "Capture proof" description connecting the proof
 *     expectations to the chosen work-package archetype. Reinforces
 *     the framing established by /incidents/new's archetype picker.
 */

type Props = {
  arrived?: boolean;

  hasSession: boolean;
  hasEvidence: boolean;
  hasNotes: boolean;
  hasApproved: boolean;

  /**
   * Curated archetype label (e.g. "Fiber splice verification"). When
   * present, the "Capture proof" state surfaces a quiet line tying
   * required proof to the chosen work package. Omit / pass empty
   * for legacy records — the line simply doesn't render.
   */
  archetypeLabel?: string;

  onOpenNotes: () => void;
  onAddEvidence: () => void;
  onMarkArrived?: () => void;
  onSubmitSession: () => void;
};

export default function NextBestAction(props: Props) {
  const { hasSession, hasEvidence, hasNotes, hasApproved, arrived, archetypeLabel } = props;

  let title = "Next best action";
  let desc = "Keep moving the proof package toward acceptance.";
  let cta = "Add proof";
  let action: "add" | "notes" | "submit" = "add";
  let tone = "border-white/10 bg-white/5";
  let showArchetypeLine = false;

  if (!hasEvidence) {
    title = "Capture proof";
    desc = "Capture the required photos, notes, and field context for acceptance.";
    cta = "Add proof";
    action = "add";
    tone = "border-amber-300/20 bg-amber-400/10";
    showArchetypeLine = true;
  } else if (!hasNotes) {
    title = "Write the notes";
    desc = "One clean summary + key site details. This makes the record ‘audit-safe’.";
    cta = "Open notes";
    action = "notes";
    tone = "border-amber-300/20 bg-amber-400/10";
  } else if (!hasSession) {
    title = "Start a field session";
    desc = "Drop one proof item to create the session timeline anchor.";
    cta = "Add proof";
    action = "add";
    tone = "border-amber-300/20 bg-amber-400/10";
  } else if (!hasApproved) {
    title = "Finish the field visit";
    desc = "Mark arrival (if needed), then submit for approval.";
    cta = "Submit for approval";
    action = "submit";
    tone = "border-green-400/20 bg-green-500/10";
  } else {
    title = "Supervisor approved";
    desc = "This session is locked + ready for filing/export steps.";
    cta = "Open notes";
    action = "notes";
    tone = "border-green-400/20 bg-green-500/10";
  }

  const onClick = () => {
    if (action === "notes") return props.onOpenNotes();
    if (action === "submit") return props.onSubmitSession();
    return props.onAddEvidence();
  };

  const btnClass =
    "w-full py-4 rounded-xl border text-lg font-semibold shadow-[0_10px_30px_rgba(0,0,0,0.45)] active:translate-y-[1px] transition";

  const submitClass =
    btnClass + " bg-emerald-600/20 border-emerald-400/20 text-emerald-100 hover:bg-emerald-600/25 hover:border-emerald-300/30";

  const arrivedClass =
    btnClass + " bg-emerald-600/10 border-emerald-400/15 text-emerald-100 hover:bg-emerald-600/15";

  return (
    <section className={"rounded-2xl border p-3 " + tone}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-gray-400">{title}</div>
          <div className="text-sm text-gray-200 truncate">{desc}</div>
          {/* PEAKOPS_ARCHETYPE_AWARE_HANDOFF_V1 (PR 85) — quiet line
              that ties the proof expectations to the chosen work
              package archetype. Renders only in the "Capture proof"
              state and only when the caller threaded a label. */}
          {showArchetypeLine && archetypeLabel ? (
            <div className="mt-1 text-[11px] text-gray-400 truncate">
              Required proof is based on the selected work package archetype.
            </div>
          ) : null}
        </div>

        {/* Right-side CTA for compact layouts (kept simple) */}
        <button
          type="button"
          className={"px-3 py-2 rounded-xl bg-white/8 border border-white/12 text-gray-100 hover:bg-white/10 active:bg-white/15 text-sm whitespace-nowrap " + (cta === "Submit for approval" ? "hidden" : "")}
          onClick={onClick}
        >
          {cta}
        </button>
      </div>

      {/* Big dock-style CTA(s) when we're in "Submit for approval" mode */}
      {cta === "Submit for approval" ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <button
            type="button"
            className={arrivedClass}
            onClick={() => {
              try {
                props.onMarkArrived?.();
              } catch {}
            }}
            disabled={!!arrived || !props.onMarkArrived}
            title={arrived ? "Already marked arrived" : "Mark arrival (optional)"}
          >
            ✓ Mark arrived
          </button>

          <button type="button" className={submitClass} onClick={props.onSubmitSession}>
            Submit for approval
          </button>
        </div>
      ) : null}
    </section>
  );
}
