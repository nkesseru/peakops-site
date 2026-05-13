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
  evidenceCount?: number;
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
    evidenceCount = 0,
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
    currentStage === "evidence" ? "Add enough evidence to continue, or add a quick note if the photos don't tell the whole story." :
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

  const checks = [
    { label: "Session started", done: !!arrived, state: arrived ? "Complete" : "Missing" },
    { label: "Photos captured", done: hasEvidence, state: hasEvidence ? (evidenceCount > 0 ? `${evidenceCount} photo${evidenceCount !== 1 ? "s" : ""}` : "Complete") : "Missing" },
    { label: "Notes saved", done: hasNotes, state: hasNotes ? "Complete" : "Missing" },
    { label: "Supervisor approved", done: hasApproved || currentStage === "review", state: (hasApproved || currentStage === "review") ? "Complete" : "Pending" },
  ];
  const allDone = checks.every((c) => c.done);
  const doneCount = checks.filter((c) => c.done).length;

  return (
    <section style={{ borderRadius: 10, border: "1px solid #1c1c1c", background: "#0b0b0b", padding: "16px 16px 12px", fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      {/* Next action header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "#C8A84E" }}>
          {title}
        </div>
        <span style={{
          fontSize: 9, fontWeight: 600, padding: "2px 7px", borderRadius: 3,
          background: allDone ? "rgba(34,197,94,0.1)" : "transparent",
          border: allDone ? "1px solid rgba(34,197,94,0.2)" : "1px solid #1c1c1c",
          color: allDone ? "#22c55e" : "#6f6f6f",
        }}>
          {allDone ? "Ready" : `${doneCount}/4`}
        </span>
      </div>
      <div style={{ fontSize: 14, color: "#f5f5f5", marginTop: 6, lineHeight: 1.4, fontWeight: 500 }}>{desc}</div>

      {/* PEAKOPS_PRIMARY_CTA_DEDUP_V2 (2026-04-29)
          The in-page NBA card section in IncidentClient already exposes
          the same primary action as a yellow CTA. This panel button is
          demoted to a neutral gray secondary so only one yellow button
          appears per screen on Arrive / Evidence / Notes / Submit
          stages. Click still works as a redundant secondary path. */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) handlePrimary(); }}
        style={{
          width: "100%",
          marginTop: 14,
          padding: "12px 0",
          borderRadius: 8,
          border: "1px solid #1c1c1c",
          background: "#101010",
          color: disabled ? "#6f6f6f" : "#b3b3b3",
          fontSize: 14,
          fontWeight: 600,
          letterSpacing: "0.02em",
          cursor: disabled ? "not-allowed" : "pointer",
          fontFamily: "inherit",
        }}
      >
        {currentStage === "arrive" && arrived ? "Arrived" : cta}
      </button>

      {/* Divider */}
      <div style={{ height: 1, background: "#1c1c1c", margin: "12px 0 8px" }} />

      {/* Readiness checklist */}
      <div>
        {checks.map((c, i) => (
          <div key={c.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderTop: i > 0 ? "1px solid #151515" : "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, background: c.done ? "#22c55e" : "#1c1c1c", flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 500, color: c.done ? "#e0e0e0" : "#6f6f6f" }}>{c.label}</span>
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: c.done ? "#22c55e" : c.state === "Pending" ? "#6f6f6f" : "#C8A84E" }}>{c.state}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
