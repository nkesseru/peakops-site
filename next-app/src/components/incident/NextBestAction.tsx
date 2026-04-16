"use client";

type Props = {
  arrived?: boolean;
  hasSession: boolean;
  hasEvidence: boolean;
  hasNotes: boolean;
  hasApproved: boolean;
  onOpenNotes: () => void;
  onAddEvidence: () => void;
  onMarkArrived?: () => void;
  onSubmitSession: () => void;
};

export default function NextBestAction(props: Props) {
  const {
    arrived,
    hasSession,
    hasEvidence,
    hasNotes,
    hasApproved,
    onOpenNotes,
    onAddEvidence,
    onMarkArrived,
    onSubmitSession,
  } = props;

  const currentStage =
    !hasSession && !arrived ? "arrive" :
    !hasEvidence && !hasNotes ? "evidence" :
    !hasNotes ? "notes" :
    !hasApproved ? "submit" :
    "review";

  const title =
    currentStage === "arrive" ? "Start the field visit" :
    currentStage === "evidence" ? "Capture evidence" :
    currentStage === "notes" ? "Add notes" :
    currentStage === "submit" ? "Ready to submit" :
    "Supervisor approval complete";

  const desc =
    currentStage === "arrive" ? "Check in on site to begin the field visit." :
    currentStage === "evidence" ? "Add enough evidence to continue, or explain the exception in notes." :
    currentStage === "notes" ? "Add notes to continue. This is your explanation fallback if no photos were captured." :
    currentStage === "submit" ? "Submit session" :
    "Approved. Ready to close.";

  const cta =
    currentStage === "arrive" ? "Mark arrived" :
    currentStage === "evidence" ? "Add evidence" :
    currentStage === "notes" ? "Add notes" :
    currentStage === "submit" ? "Submit session" :
    "Approved & locked";

  const disabled = currentStage === "review";

  const tone =
    currentStage === "review"
      ? "border-green-400/20 bg-green-500/10"
      : currentStage === "submit"
      ? "border-emerald-400/20 bg-emerald-500/10"
      : "border-indigo-400/20 bg-indigo-500/10";

  function handlePrimary() {
    if (currentStage === "arrive") {
      try { onMarkArrived?.(); } catch {}
      return;
    }
    if (currentStage === "evidence") {
      onAddEvidence();
      return;
    }
    if (currentStage === "notes") {
      onOpenNotes();
      return;
    }
    if (currentStage === "submit") {
      onSubmitSession();
      return;
    }
  }

  return (
    <section className={"rounded-2xl border p-3 " + tone}>
      <div className="text-[11px] uppercase tracking-wide text-gray-400">{title}</div>
      <div className="mt-1 text-sm text-gray-100">{desc}</div>

      <div className="mt-3">
        <button
          type="button"
          className={
            "w-full py-4 rounded-xl border text-lg font-semibold transition shadow-[0_10px_30px_rgba(0,0,0,0.45)] " +
            (disabled
              ? "bg-white/5 border-white/10 text-white/40 cursor-not-allowed"
              : currentStage === "submit"
              ? "bg-emerald-600/80 border-emerald-400/30 text-white hover:bg-emerald-500"
              : "bg-white/8 border-white/12 text-white hover:bg-white/10 hover:border-white/20")
          }
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            handlePrimary();
          }}
        >
          {currentStage === "arrive" && arrived ? "✓ Arrived" : cta}
        </button>
      </div>
    </section>
  );
}
