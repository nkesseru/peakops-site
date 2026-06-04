// PEAKOPS_RECOVERY_UI_V1 (PR 127c-b)
//
// "Where is the job?" section. Per planning override #8:
// recovery actions require address. If missing, flag as data defect.
// Do NOT hide the section.

"use client";

import { googleMapsUrl } from "@/lib/recovery/mapsUrl";

type Props = {
  jobTitle?: string;
  jobLocation?: string;
  incidentId: string;
  orgId: string;
};

export function WhereSection({ jobTitle, jobLocation, incidentId, orgId }: Props) {
  const title = String(jobTitle || "").trim();
  const location = String(jobLocation || "").trim();
  const hasAddress = location.length > 0;
  const mapsUrl = hasAddress ? googleMapsUrl(location) : "";

  return (
    <section
      className={
        "rounded-xl px-4 py-4 space-y-2 " +
        (hasAddress
          ? "border border-white/10 bg-white/[0.03]"
          : "border border-red-400/40 bg-red-500/[0.08]")
      }
    >
      <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
        Where
      </div>
      {title ? (
        <div className="text-base text-white leading-snug">{title}</div>
      ) : null}
      {hasAddress ? (
        <>
          <div className="text-sm text-gray-200">{location}</div>
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-blue-300 hover:text-blue-200 underline"
          >
            Open in Maps →
          </a>
        </>
      ) : (
        <div className="space-y-1">
          <div className="text-[13px] font-semibold text-red-200">⚠ Data defect</div>
          <div className="text-[12px] text-red-100/85 leading-relaxed">
            This record has no address. Field crew cannot route to the job.
          </div>
          <a
            href={`/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`}
            className="inline-flex text-[11px] mt-1 text-red-100/90 hover:text-white underline"
          >
            Open record to add address →
          </a>
        </div>
      )}
    </section>
  );
}
