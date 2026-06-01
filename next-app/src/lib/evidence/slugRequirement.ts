// PEAKOPS_SHARED_SLUG_REQUIREMENT_V1 (PR 117)
//
// Shared client-side slug derivation for required-proof labels.
// Extracted from app/incidents/[incidentId]/add-evidence/AddEvidenceClient.tsx
// so the proof-slot dossier on Summary uses the same algorithm.
//
// MUST stay byte-identical to:
//   - functions_clean/_readiness.js → slugRequirement
//     (server-side authority used by readinessCache + export packet)
//   - AddEvidenceClient.tsx           (file-picker + camera slot capture)
//
// Backend (PR 94a addEvidenceV1) validates persisted requirementKey
// against /^[a-z0-9-]{1,120}$/ and silently drops anything else. This
// helper enforces the same shape so client and server agree on key
// equality without surprises.

export function slugRequirement(label: string): string {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}
