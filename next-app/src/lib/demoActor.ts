export function isDemoIncident(incidentId: string): boolean {
  return process.env.NODE_ENV !== "production" && String(incidentId || "").trim() === "inc_demo";
}

export function ensureDemoActor(incidentId: string): void {
  if (!isDemoIncident(incidentId)) return;
  try {
    if (typeof window === "undefined") return;
    if (!localStorage.getItem("peakops_uid")) localStorage.setItem("peakops_uid", "dev-admin");
    if (!localStorage.getItem("peakops_role")) localStorage.setItem("peakops_role", "admin");
  } catch {}
}

export function getActorUid(): string {
  try {
    return String(localStorage.getItem("peakops_uid") || "dev-admin").trim();
  } catch {
    return "dev-admin";
  }
}

export function getActorRole(): string {
  try {
    return String(localStorage.getItem("peakops_role") || "admin").trim().toLowerCase();
  } catch {
    return "admin";
  }
}

