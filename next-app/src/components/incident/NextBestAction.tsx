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
  const { hasSession, hasEvidence, hasNotes, hasApproved, arrived } = props;

  let title = "Next best action";
  let desc = "Keep moving the incident toward supervisor-ready.";
  let cta = "Add evidence";
  let action: "add" | "notes" | "submit" = "add";
  let tone = "border-white/10 bg-white/5";

  if (!hasEvidence) {
    title = "Capture evidence";
    desc = "Add at least 4 photos/docs so the record is defensible.";
    cta = "Add evidence";
    action = "add";
    tone = "border-amber-300/20 bg-amber-400/10";
  } else if (!hasNotes) {
    title = "Write the notes";
    desc = "One clean summary + key site details. This makes the record ‘audit-safe’.";
    cta = "Open notes";
    action = "notes";
    tone = "border-amber-300/20 bg-amber-400/10";
  } else if (!hasSession) {
    title = "Start a field session";
    desc = "Drop one evidence item to create the session timeline anchor.";
    cta = "Add evidence";
    action = "add";
    tone = "border-amber-300/20 bg-amber-400/10";
  } else if (!hasApproved) {
    title = "Finish the field visit";
    desc = "Mark arrival (if needed), then submit session for supervisor review.";
    cta = "Submit session";
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

  const primaryCtaClass =
    btnClass + " bg-white/8 border-white/12 text-white hover:bg-white/10 hover:border-white/20 active:bg-white/12";

  const notesClass =
    btnClass + " bg-blue-600/20 border-blue-400/20 text-blue-100 hover:bg-blue-600/25 hover:border-blue-300/30";

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
        </div>

        {/* Right-side CTA for compact layouts (kept simple) */}
        <button
          type="button"
          className={"px-3 py-2 rounded-xl bg-white/8 border border-white/12 text-gray-100 hover:bg-white/10 active:bg-white/15 text-sm whitespace-nowrap " + (cta === "Submit session" ? "hidden" : "")}
          onClick={onClick}
        >
          {cta}
        </button>
      </div>

      {/* Big dock-style CTA(s) when we're in "Submit session" mode */}
      {cta === "Submit session" ? (
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
            Submit session
          </button>
        </div>
      ) : null}

      {/* (Optional) If you want the BIG buttons always (like before), we can move these into IncidentClient’s bottom dock later. */}
    </section>
  );
}
