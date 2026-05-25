export function normalizeIncidentStatusShared(status: unknown): string {
  return String(status || "").trim().toLowerCase();
}

export function incidentStatusLabel(status: unknown): string {
  const s = normalizeIncidentStatusShared(status);
  if (!s) return "-";

  switch (s) {
    // PEAKOPS_DRAFT_STATUS_LABEL_V1 (PR 72)
    // "draft" is the new default status the proof-workflow create
    // flow writes via createIncidentV1 (PR 68). Adding the label
    // here so the status pill renders correctly on the destination
    // surface right after creation — without this case it fell
    // through to the default and rendered the wrong colour.
    case "draft":
      return "Draft";
    case "open":
      return "Open";
    case "in_progress":
      return "In Progress";
    case "review":
      return "In Review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "closed":
      return "Closed";
    default:
      return s
        .split("_")
        .map(part => (part ? part[0].toUpperCase() + part.slice(1) : part))
        .join(" ");
  }
}

export function incidentStatusPill(status: unknown): string {
  const s = normalizeIncidentStatusShared(status);

  switch (s) {
    // PEAKOPS_DRAFT_STATUS_LABEL_V1 (PR 72) — calm amber tone matches
    // the dossier voice; sits visually between "needs first capture"
    // and "active" without competing with the in-progress cyan.
    case "draft":
      return "bg-amber-500/12 border-amber-300/25 text-amber-100";
    case "open":
      return "bg-emerald-500/15 border-emerald-300/30 text-emerald-100";
    case "in_progress":
      return "bg-cyan-500/15 border-cyan-300/30 text-cyan-100";
    case "review":
      return "bg-amber-500/15 border-amber-300/30 text-amber-100";
    case "approved":
      return "bg-green-600/20 border-green-400/30 text-green-100";
    case "rejected":
      return "bg-rose-500/15 border-rose-300/30 text-rose-100";
    case "closed":
      return "bg-white/10 border-white/20 text-gray-200";
    default:
      return "bg-white/10 border-white/20 text-gray-200";
  }
}
