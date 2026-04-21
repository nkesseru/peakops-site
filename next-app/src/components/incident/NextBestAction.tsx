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
    { label: "Field session started", done: !!arrived, state: arrived ? "Done" : "Missing" },
    { label: "Evidence captured", done: hasEvidence, state: hasEvidence ? (evidenceCount > 0 ? `${evidenceCount} item${evidenceCount !== 1 ? "s" : ""}` : "Done") : "Missing" },
    { label: "Notes saved", done: hasNotes, state: hasNotes ? "Done" : "Missing" },
    { label: "Supervisor approved", done: hasApproved || currentStage === "review", state: (hasApproved || currentStage === "review") ? "Done" : "Pending" },
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

      {/* Primary CTA */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) handlePrimary(); }}
        style={{
          width: "100%",
          marginTop: 14,
          padding: "12px 0",
          borderRadius: 8,
          border: disabled ? "1px solid #1c1c1c" : "none",
          background: disabled ? "#101010" : "linear-gradient(180deg, #9A7E2A 0%, #B89A3E 100%)",
          color: disabled ? "#6f6f6f" : "#050505",
          fontSize: 15,
          fontWeight: 800,
          letterSpacing: "0.02em",
          cursor: disabled ? "not-allowed" : "pointer",
          fontFamily: "inherit",
          boxShadow: disabled ? "none" : "0 2px 8px rgba(200,168,78,0.15), inset 0 1px 0 rgba(255,255,255,0.08)",
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
