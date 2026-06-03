// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
//
// Revenue display component with confidence-type indicator.
// "Revenue at risk" is intentionally NOT styled as a billed amount —
// the wedge guard reminder is in the type pill ("estimated" / "unknown")
// + a small "for internal tracking only" disclaimer when prominent.

import type { RevenueAtRisk, RevenueType } from "@/lib/recovery/types";
import { formatRevenue, REVENUE_TYPE_SHORT } from "@/lib/recovery/displayConstants";

type Props = {
  revenue: Pick<RevenueAtRisk, "amount" | "currency" | "type">;
  size?: "sm" | "md" | "lg";
  showType?: boolean;
};

const TYPE_CLASS: Record<RevenueType, string> = {
  actual: "text-emerald-300",
  estimated: "text-amber-300",
  unknown: "text-gray-400",
};

export function RevenueDisplay({ revenue, size = "md", showType = true }: Props) {
  const amountFormatted = formatRevenue(revenue.amount, revenue.currency || "USD");
  const sizeClass = size === "lg"
    ? "text-2xl sm:text-3xl font-semibold"
    : size === "sm"
      ? "text-xs font-medium"
      : "text-sm font-semibold";
  const typeSize = size === "lg" ? "text-[11px]" : "text-[10px]";

  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`text-white ${sizeClass} tabular-nums`}>{amountFormatted}</span>
      {showType && (
        <span className={`${typeSize} uppercase tracking-wider font-medium ${TYPE_CLASS[revenue.type]}`}>
          {REVENUE_TYPE_SHORT[revenue.type]}
        </span>
      )}
    </span>
  );
}
