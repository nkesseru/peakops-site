/**
 * PEAKOPS_TELECOM_TEMPLATES_V1 (PR 86)
 *
 * The first specialized industry catalog: telecom / broadband
 * closeout work-package templates. Surfaced by /incidents/new
 * when the active org is in TELECOM_ORGS (see orgIndustry.ts).
 *
 * Each template is opinionated about what "acceptance-ready"
 * means for that work type. The required-proof list is the
 * single most load-bearing piece of data on this page — it sets
 * the operator's mental model for what they're assembling
 * before they leave the page.
 *
 * Backend mapping (PR 86 foundation):
 *   Two of the four templates map cleanly to existing
 *   ARCHETYPE_ENUM values (PR 81a):
 *     - Fiber Splice Package Closeout      → fiber_splice_verification
 *     - Restoration Completion Closeout    → storm_restoration_proof
 *   The other two collapse to "custom" on the wire pending a
 *   small backend enum extension (the "next recommended PR"
 *   called out in the PR 86 body):
 *     - Drop Installation Completion       → custom (bridge)
 *     - Punch-List Resolution              → custom (bridge)
 *
 * The wire-level loss is INVISIBLE to the operator — the
 * template's full label/description/proof list lives in this
 * module and renders losslessly. Only the Firestore archetype
 * field is reduced. PR 87 (backend) closes the gap.
 *
 * What this module is NOT:
 *   - Not a template builder (no UI for editing templates)
 *   - Not a rules engine (acceptanceCriteria is informational
 *     text, not enforced)
 *   - Not a dynamic forms engine (each template is a static
 *     literal in this file)
 *   - Not a workflow engine (no state transitions defined here)
 */

import type { Archetype } from "@/lib/incidents/newIncidentDraft";

export type TelecomTemplate = {
  /** Stable client-side identifier. Used in URLs/analytics; never user-facing. */
  key: string;
  /** Backend ARCHETYPE_ENUM value this template persists as. */
  archetype: Archetype;
  /** Display label on the picker card + downstream surfaces. */
  label: string;
  /** One-sentence framing of what the packet proves. */
  purpose: string;
  /** Items the proof package must contain to feel acceptance-ready. */
  requiredProof: readonly string[];
  /** Items that strengthen the packet but aren't strictly required. */
  optionalProof: readonly string[];
  /** Informational acceptance gates — NOT enforced by validation logic. */
  acceptanceCriteria: readonly string[];
  /** Hint title operators see when starting a record from this template. */
  suggestedPacketTitle: string;
  /** Calm one-line guidance shown beneath the card body. */
  operatorGuidance: string;
};

export const TELECOM_TEMPLATES: readonly TelecomTemplate[] = [
  {
    key: "fiber_splice_package_closeout",
    archetype: "fiber_splice_verification",
    label: "Fiber Splice Package Closeout",
    purpose: "Prove splice work was completed and ready for acceptance.",
    requiredProof: [
      "Splice enclosure photo",
      "Splice tray photo",
      "Fiber labeling / tag photo",
      "Vault or handhole context photo",
      "Redline / as-built attachment",
      "Technician completion note",
      "QA reviewer signoff",
    ],
    optionalProof: [
      "OTDR trace screenshot",
      "Splice loss reading",
    ],
    acceptanceCriteria: [
      "Required photos uploaded",
      "Completion note present",
      "QA signoff present",
      "Packet ready for acceptance / export",
    ],
    suggestedPacketTitle: "Fiber splice closeout — {site}",
    operatorGuidance: "Capture all splice photos and the as-built attachment before leaving the vault.",
  },
  {
    key: "restoration_completion_closeout",
    archetype: "storm_restoration_proof",
    label: "Restoration Completion Closeout",
    purpose: "Prove site restoration was completed after field work.",
    requiredProof: [
      "Before photo",
      "After photo",
      "Surface restoration photo",
      "Traffic control removed / site safe photo",
      "Location / context photo",
      "Technician completion note",
      "QA reviewer signoff",
    ],
    optionalProof: [
      "Inspector signoff photo",
      "Permit closure attachment",
    ],
    acceptanceCriteria: [
      "Before + after photos uploaded",
      "Site safe confirmation captured",
      "Completion note present",
      "QA signoff present",
    ],
    suggestedPacketTitle: "Restoration closeout — {site}",
    operatorGuidance: "Photograph the same angle for before/after so the comparison reads cleanly.",
  },
  {
    key: "drop_installation_completion",
    // PR 86 bridge: collapses to "custom" on the wire. PR 87
    // backend ext adds drop_installation_completion to
    // ARCHETYPE_ENUM and removes this bridge.
    archetype: "custom",
    label: "Drop Installation Completion",
    purpose: "Prove customer drop or site connection work was completed.",
    requiredProof: [
      "Pedestal / handhole photo",
      "Customer premises exterior photo",
      "Connection / terminal photo",
      "Before photo",
      "After photo",
      "Technician completion note",
    ],
    optionalProof: [
      "Customer / PM signoff",
      "Speed test screenshot",
    ],
    acceptanceCriteria: [
      "Pedestal + premises + terminal photos uploaded",
      "Before / after photo set complete",
      "Completion note present",
      "Customer or PM signoff (optional)",
    ],
    suggestedPacketTitle: "Drop install closeout — {address}",
    operatorGuidance: "Capture both ends of the drop — pedestal AND customer premises.",
  },
  {
    key: "punch_list_resolution",
    // PR 86 bridge: collapses to "custom" on the wire. PR 87
    // backend ext adds punch_list_resolution to ARCHETYPE_ENUM.
    archetype: "custom",
    label: "Punch-List Resolution",
    purpose: "Prove previously rejected or incomplete items were corrected.",
    requiredProof: [
      "Original issue reference",
      "Corrective action note",
      "Before-correction photo",
      "After-correction photo",
      "QA approval",
      "Final acceptance note",
    ],
    optionalProof: [
      "Re-inspector signoff",
    ],
    acceptanceCriteria: [
      "Original issue cited",
      "Before + after photos uploaded",
      "Corrective action documented",
      "QA approval captured",
    ],
    suggestedPacketTitle: "Punch-list resolution — {site}",
    operatorGuidance: "Reference the original rejected packet so the audit trail closes cleanly.",
  },
];

/**
 * Lookup a telecom template by its client-side key. Returns null
 * for unknown keys so call sites can fall back gracefully.
 */
export function getTelecomTemplate(key: string | null | undefined): TelecomTemplate | null {
  const k = String(key || "").trim();
  if (!k) return null;
  return TELECOM_TEMPLATES.find((t) => t.key === k) || null;
}
