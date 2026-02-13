"use client";

import { useEffect, useMemo, useState } from "react";

type FilingType = "NORS_INITIAL" | "DIRS_INITIAL";

function fmtHMS(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const r = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${r}`;
}

function fmtTime(epochSec: number) {
  try {
    const d = new Date(epochSec * 1000);
    return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "2-digit" });
  } catch {
    return "—";
  }
}

function dueSeconds(kind: FilingType) {
  // TODO: wire exact rules per customer/regime.
  // Placeholder defaults (feel free to change):
  if (kind === "NORS_INITIAL") return 2 * 3600; // 2 hours
  if (kind === "DIRS_INITIAL") return 4 * 3600; // 4 hours
  return 0;
}

export default function FilingCountdown(props: {
  incidentStartSec?: number;
  filingType: FilingType;
  label: string;
}) {
  const { incidentStartSec, filingType, label } = props;

  const start = incidentStartSec && incidentStartSec > 0 ? incidentStartSec : undefined;
  const dueAt = useMemo(() => (start ? start + dueSeconds(filingType) : undefined), [start, filingType]);

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining = start && dueAt ? dueAt - now : 0;
  const isLate = !!(start && dueAt && now >= dueAt);

  const ring = isLate ? "border-red-400/25" : "border-white/10";
  const tint = isLate ? "bg-red-500/10 text-red-200" : "bg-white/5 text-gray-200";

  const tMinus = start ? fmtHMS(remaining) : "—";
  const startTxt = start ? fmtTime(start) : "—";
  const dueTxt = dueAt ? fmtTime(dueAt) : "—";

  return (
    <div className={"rounded-xl border px-3 py-2 " + ring + " " + tint} title={`${label} • ${filingType}`}>
      <div className="flex items-baseline gap-2">
        <div className="text-[11px] uppercase tracking-wider text-gray-300/80">{label}</div>
        <div className="text-[22px] font-semibold tracking-tight leading-none">
          <span className="text-gray-300/90">T-</span> {tMinus}
        </div>
      </div>
      <div className="mt-1 text-[11px] text-gray-300/70">
        Start: {startTxt} <span className="mx-1 text-gray-400/40">•</span> Due: {dueTxt}
      </div>
    </div>
  );
}
