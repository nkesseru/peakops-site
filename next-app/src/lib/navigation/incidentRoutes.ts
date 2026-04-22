/**
 * Canonical path builders for all intra-incident navigation.
 *
 * Every `router.push` / `router.replace` / `<a href>` that lands on an
 * /incidents/* URL must go through one of these. Doing it inline is exactly
 * how orgId keeps getting dropped: one forgotten `?orgId=...` breaks the
 * downstream page's refresh (because IncidentClient reads orgId strictly from
 * searchParams per the single-source-of-truth rule).
 *
 * Rules:
 *   - orgId is required. If a caller doesn't have orgId, it should block the
 *     action with a clean empty state rather than navigating to a broken URL.
 *   - hash and extra query params are optional and preserved in addition to
 *     orgId — never in place of it.
 */

export type IncidentRouteOpts = {
  /** Optional fragment like "evidence" (rendered as "#evidence"). */
  hash?: string;
  /** Extra query parameters merged after orgId. */
  extraQuery?: Record<string, string | number | boolean | undefined | null>;
};

function buildQuery(orgId: string, extra?: IncidentRouteOpts["extraQuery"]): string {
  const params = new URLSearchParams();
  params.set("orgId", String(orgId || "").trim());
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (!s) continue;
      params.set(k, s);
    }
  }
  return params.toString();
}

function buildHash(hash?: string): string {
  if (!hash) return "";
  const trimmed = String(hash).replace(/^#+/, "");
  return trimmed ? `#${trimmed}` : "";
}

function encIncident(incidentId: string): string {
  return encodeURIComponent(String(incidentId || "").trim());
}

/** Overview: /incidents/{id}?orgId={org}[&…][#hash] */
export function incidentPath(incidentId: string, orgId: string, opts: IncidentRouteOpts = {}): string {
  return `/incidents/${encIncident(incidentId)}?${buildQuery(orgId, opts.extraQuery)}${buildHash(opts.hash)}`;
}

/** Supervisor review: /incidents/{id}/review?orgId={org}[&…] */
export function reviewPath(incidentId: string, orgId: string, opts: IncidentRouteOpts = {}): string {
  return `/incidents/${encIncident(incidentId)}/review?${buildQuery(orgId, opts.extraQuery)}${buildHash(opts.hash)}`;
}

/** Notes: /incidents/{id}/notes?orgId={org}[&…] */
export function notesPath(incidentId: string, orgId: string, opts: IncidentRouteOpts = {}): string {
  return `/incidents/${encIncident(incidentId)}/notes?${buildQuery(orgId, opts.extraQuery)}${buildHash(opts.hash)}`;
}

/** Summary: /incidents/{id}/summary?orgId={org}[&…] */
export function summaryPath(incidentId: string, orgId: string, opts: IncidentRouteOpts = {}): string {
  return `/incidents/${encIncident(incidentId)}/summary?${buildQuery(orgId, opts.extraQuery)}${buildHash(opts.hash)}`;
}

/** Add evidence: /incidents/{id}/add-evidence?orgId={org}[&…] */
export function addEvidencePath(incidentId: string, orgId: string, opts: IncidentRouteOpts = {}): string {
  return `/incidents/${encIncident(incidentId)}/add-evidence?${buildQuery(orgId, opts.extraQuery)}${buildHash(opts.hash)}`;
}

/**
 * Quick predicate: is orgId present enough to allow navigation?
 * Callers should use this to gate "Mark arrived", "+ Evidence", "Go to Review"
 * etc. instead of attempting a route transition with an empty orgId.
 */
export function hasUsableOrgId(orgId: string | undefined | null): boolean {
  return !!String(orgId || "").trim();
}
