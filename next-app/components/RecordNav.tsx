"use client";

/**
 * PEAKOPS_RECORD_NAV_V1
 *
 * Quiet horizontal route bridge across the core operational surfaces
 * of a single incident record:
 *
 *   Dashboard · Incident · Summary · Review · File Addendum
 *
 * Intentional voice:
 *   - calm, premium, operational
 *   - matches Summary's dossier-eyebrow vocabulary
 *   - reads as breadcrumb-adjacent, NOT as a navbar / app-shell
 *
 * Placement contract (callers honor this; not enforced here):
 *   - Render directly below the page's identity hero / meta line
 *   - Non-sticky
 *
 * File Addendum is hidden unless the incident is sealed (closed /
 * locked) — the addendum flow is closed-state-only by spec (PR 43).
 *
 * Active page:
 *   - rendered as a non-interactive <span> with aria-current="page"
 *     and brighter text (text-gray-100)
 *   - inactive items are <button onClick={router.push(...)}> with
 *     hover lift to text-gray-100
 *   - separators between items are subtle "·" in text-white/20
 *
 * The whole strip is a <nav aria-label="Record"> landmark so
 * assistive technology can find and skip it cleanly.
 */

import { useRouter } from "next/navigation";

export type RecordNavCurrent =
  | "dashboard"
  | "incident"
  | "summary"
  | "review"
  | "addendum";

type Props = {
  incidentId: string;
  orgId: string;
  current: RecordNavCurrent;
  /** When true, "File Addendum" surfaces. Default false (open-state). */
  isSealed?: boolean;
};

type Item = { key: RecordNavCurrent; label: string; href: string };

export default function RecordNav({
  incidentId,
  orgId,
  current,
  isSealed = false,
}: Props) {
  const router = useRouter();
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const encId = encodeURIComponent(incidentId);

  const items: Item[] = [
    { key: "dashboard", label: "Dashboard", href: `/dashboard` },
    { key: "incident", label: "Incident", href: `/incidents/${encId}${qs}` },
    { key: "summary", label: "Summary", href: `/incidents/${encId}/summary${qs}` },
    { key: "review", label: "Review", href: `/incidents/${encId}/review${qs}` },
  ];
  if (isSealed) {
    items.push({
      key: "addendum",
      label: "File Addendum",
      href: `/incidents/${encId}/add-addendum${qs}`,
    });
  }

  return (
    <nav
      aria-label="Record"
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] tracking-[0.04em] font-medium"
    >
      {items.map((item, i) => (
        <span key={item.key} className="flex items-center gap-2.5">
          {i > 0 ? (
            <span aria-hidden="true" className="text-white/20">
              ·
            </span>
          ) : null}
          {item.key === current ? (
            <span
              className="text-gray-100 cursor-default"
              aria-current="page"
            >
              {item.label}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => router.push(item.href)}
              className="text-gray-400 hover:text-gray-100 transition-colors"
            >
              {item.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
