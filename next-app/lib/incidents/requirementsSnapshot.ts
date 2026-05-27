/**
 * PEAKOPS_REQUIREMENTS_SNAPSHOT_V1 (PR 90)
 *
 * Single resolver for "what proof does this field record need
 * to be acceptance-ready?"
 *
 * Resolution order:
 *   1. Snapshot on the incident doc  (PR 89a backend write)
 *      → source: "snapshot"
 *   2. Static archetype catalog      (legacy records pre-PR-89a,
 *                                     or records with archetypes
 *                                     not yet known by the
 *                                     backend mirror)
 *      → source: "archetype_fallback"
 *   3. Nothing                       (record has no archetype
 *                                     and no snapshot)
 *      → source: "none"
 *
 * Why the snapshot wins:
 *   Template edits in code or in Firestore (future PRs) must
 *   NEVER rewrite a record's requirements after creation. The
 *   snapshot is the audit-stable contract; the static catalog
 *   is the "what would the requirements be if we created this
 *   today" fallback for records that pre-date the snapshot
 *   write.
 *
 * What this helper is NOT:
 *   - Not a validation engine — returns labels, doesn't enforce
 *   - Not a rules engine — no conditional logic
 *   - Not a form schema — string[] only
 *   - Not aware of customer templates / per-job overrides
 *     (deferred to PR 91+); future versions read those layers
 *     before falling through to the archetype catalog
 */

import {
  ARCHETYPE_DETAILS,
  ARCHETYPE_VALUES,
  type Archetype,
} from "./newIncidentDraft";

export type RequirementsSnapshot = {
  requiredProof: string[];
  optionalProof: string[];
  acceptanceCriteria: string[];
  /** Resolver path that produced these requirements. */
  source: "snapshot" | "archetype_fallback" | "none";
  /**
   * PR 92 — When source === "snapshot", the underlying source the
   * backend recorded at create time (PR 89a/91). Lets the UI
   * surface a small audit affordance showing which layer fed the
   * snapshot ("customer template · v3", "org template · v1",
   * "archetype defaults"). For source === "archetype_fallback",
   * this is "archetype" since the static catalog is conceptually
   * the same source. Undefined for source === "none".
   */
  snapshotSource?: "customer_template" | "org_template" | "archetype";
  /** Doc id under orgs/{org}/templates/ when sourced from a template. */
  templateKey?: string;
  /** Monotonic template version captured at snapshot write time. */
  templateVersion?: number;
};

/**
 * Narrow shape used by the helper. Accepts both the full
 * getIncidentV1 doc shape AND a minimal { archetype,
 * requirements } object so callers don't need to thread the
 * entire incident through.
 */
export type RequirementsInput = {
  archetype?: string | null;
  requirements?: {
    requiredProof?: unknown;
    optionalProof?: unknown;
    acceptanceCriteria?: unknown;
    source?: unknown;
    snapshottedAt?: unknown;
  } | null;
};

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "")).filter((x) => x.length > 0);
}

/**
 * Resolve the effective requirements for an incident record.
 * Snapshot wins. Falls back to the static catalog when no
 * snapshot exists. Returns an empty record with source "none"
 * if neither path yields anything.
 */
export function effectiveRequirements(input: RequirementsInput | null | undefined): RequirementsSnapshot {
  // 1. Snapshot path — only when the doc carries a requirements
  //    object with at least one required-proof item.
  const snap = input?.requirements;
  if (snap && Array.isArray((snap as { requiredProof?: unknown }).requiredProof)) {
    const requiredProof = toStringArray((snap as { requiredProof?: unknown }).requiredProof);
    if (requiredProof.length > 0) {
      // PR 92 — preserve the underlying snapshot source + templateKey
      // + templateVersion so the UI can surface a small audit
      // affordance ("Customer template · v3", etc.).
      const rawSource = String((snap as { source?: unknown }).source || "").trim();
      const validSnapshotSources = new Set(["customer_template", "org_template", "archetype"]);
      const snapshotSource = validSnapshotSources.has(rawSource)
        ? (rawSource as "customer_template" | "org_template" | "archetype")
        : undefined;
      const templateKeyRaw = (snap as { templateKey?: unknown }).templateKey;
      const templateKey =
        typeof templateKeyRaw === "string" && templateKeyRaw.length > 0
          ? templateKeyRaw
          : undefined;
      const versionRaw = (snap as { templateVersion?: unknown }).templateVersion;
      const templateVersion = typeof versionRaw === "number" && Number.isFinite(versionRaw)
        ? versionRaw
        : undefined;

      return {
        requiredProof,
        optionalProof: toStringArray((snap as { optionalProof?: unknown }).optionalProof),
        acceptanceCriteria: toStringArray((snap as { acceptanceCriteria?: unknown }).acceptanceCriteria),
        source: "snapshot",
        snapshotSource,
        templateKey,
        templateVersion,
      };
    }
  }

  // 2. Archetype fallback — for records created before PR 89a
  //    or with archetypes not yet mirrored in the backend
  //    catalog. The static next-app catalog is the source.
  const arch = String(input?.archetype || "").trim();
  if (arch && (ARCHETYPE_VALUES as readonly string[]).includes(arch)) {
    const detail = ARCHETYPE_DETAILS[arch as Archetype];
    if (detail) {
      // ARCHETYPE_DETAILS only carries requiredProof + purpose +
      // packetUse. optionalProof and acceptanceCriteria live in the
      // backend catalog mirror and the telecom-template catalog;
      // the legacy fallback returns empty arrays for those so the
      // UI renders consistently regardless of source.
      return {
        requiredProof: [...detail.requiredProof],
        optionalProof: [],
        acceptanceCriteria: [],
        source: "archetype_fallback",
        // PR 92 — surface as "archetype" to the UI; legacy records
        // and snapshot-archetype records render the same audit
        // label ("Archetype defaults").
        snapshotSource: "archetype",
      };
    }
  }

  // 3. No archetype, no snapshot — nothing to render.
  return {
    requiredProof: [],
    optionalProof: [],
    acceptanceCriteria: [],
    source: "none",
  };
}
