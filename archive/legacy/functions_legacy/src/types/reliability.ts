// src/types/reliability.ts

export type DataQuality = "GOOD" | "ESTIMATED" | "MISSING" | "BAD";
export type ReliabilityStatus = "OK" | "WARN" | "CRITICAL";

export type ReliabilityMetric = {
  orgId: string;
  regionId: string; // e.g. "SYSTEM", "WA-EAST"
  year: number;
  source: "EIA_111_6" | "EIA_114" | "EIA_115" | "UTILITY_EXPORT";

  saidiHours: number | null;
  saifiInterruptions: number | null;
  caidiHours: number | null;

  dataQuality: DataQuality;

  metricId: string;
  importedAt: FirebaseFirestore.Timestamp;
  importedBy: string;
  sourceFileName?: string;
  notes?: string;

  saidiStatus?: ReliabilityStatus;
  saifiStatus?: ReliabilityStatus;
  caidiStatus?: ReliabilityStatus;
  overallStatus?: ReliabilityStatus;
};

export type ReliabilityIngestRaw = {
  orgId: string;
  regionId?: string;
  year?: number;

  rawRow: any;
  parsed: Partial<ReliabilityMetric> | null;

  status: "ACCEPTED" | "REJECTED";
  errorCode?: string;
  errorMessage?: string;

  importedAt: FirebaseFirestore.Timestamp;
  importedBy: string;
  source: string;
  sourceFileName?: string;
};

export function makeMetricId(
  orgId: string,
  regionId: string,
  year: number,
  source: string
): string {
  return `${orgId}_${regionId}_${year}_${source}`.toUpperCase();
}
