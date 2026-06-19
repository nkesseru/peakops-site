// PEAKOPS_ORG_KIND_V1 (2026-05-06)
//
// Single source of truth for "what kind of tenant is this orgId?"
// Drives the demo↔customer separation invariant from
// docs/MULTI_ORG_RELATIONSHIP_MODEL.md § Non-Negotiable Invariants:
//
//   "No real customer org may share with, relate to, or borrow members
//    from a demo org. No demo org may be billed."
//
// The kind also lives at orgs/{orgId}.kind. This module is the safe
// accessor: it answers without needing a Firestore read by short-
// circuiting on a known-protected id list, and it accepts an
// already-loaded org snapshot if the caller has one.
//
// Design rules:
//   - "demo-org" always resolves to "demo" regardless of any doc field.
//     No override path can flip it. (Belt-and-braces against an
//     accidental backfill / write that sets kind: "customer" on
//     demo-org and would cross the demo↔customer barrier.)
//   - missing kind on a non-protected org defaults to "customer".
//     Conservative for the foundation phase; we tighten to strict-
//     explicit once the backfill has run on production data.
//   - never throws on missing fields. Every accessor returns a
//     defined value.

export type OrgKind = "demo" | "customer" | "internal";

export type OrgKindInput =
  | { kind?: OrgKind | string | null; [key: string]: unknown }
  | null
  | undefined;

const PROTECTED_DEMO_ORG_IDS: ReadonlySet<string> = new Set([
  "demo-org",
]);

const PROTECTED_INTERNAL_ORG_IDS: ReadonlySet<string> = new Set<string>([
  // Reserved for support tooling. Empty in v1.
]);

function normalize(orgId: string | null | undefined): string {
  return String(orgId || "").trim();
}

function coerceKind(raw: unknown): OrgKind | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "demo" || v === "customer" || v === "internal") return v;
  return null;
}

/**
 * Resolution order:
 *   1. protected demo id list  → "demo"  (always)
 *   2. protected internal list → "internal"
 *   3. orgDoc.kind if valid    → that
 *   4. fallback                → "customer"
 *
 * `orgDoc` is optional. Pass it when you already have the org snapshot
 * to avoid an extra Firestore read; omit it when only the orgId is at
 * hand and the protected lists are sufficient to decide.
 */
export function getOrgKind(
  orgId: string | null | undefined,
  orgDoc?: OrgKindInput,
): OrgKind {
  const id = normalize(orgId);
  if (id && PROTECTED_DEMO_ORG_IDS.has(id)) return "demo";
  if (id && PROTECTED_INTERNAL_ORG_IDS.has(id)) return "internal";
  const fromDoc = coerceKind(orgDoc?.kind);
  if (fromDoc) return fromDoc;
  return "customer";
}

export function isDemoOrg(
  orgId: string | null | undefined,
  orgDoc?: OrgKindInput,
): boolean {
  return getOrgKind(orgId, orgDoc) === "demo";
}

export function isCustomerOrg(
  orgId: string | null | undefined,
  orgDoc?: OrgKindInput,
): boolean {
  return getOrgKind(orgId, orgDoc) === "customer";
}
