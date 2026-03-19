// src/types/reliability.ts

export type DataQuality = "GOOD" | "ESTIMATED" | "MISSING" | "BAD";
export type ReliabilityStatus = "OK" | "WARN" | "CRITICAL";

export interface ReliabilityMetric {
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
  sourceFileName?: string | null;
  notes?: string;

  saidiStatus?: ReliabilityStatus;
  saifiStatus?: ReliabilityStatus;
  caidiStatus?: ReliabilityStatus;
  overallStatus?: ReliabilityStatus;
}

// Raw ingest log for each row
export interface ReliabilityIngestRaw {
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
  sourceFileName?: string | null;
}

// Org-level threshold config
export interface ReliabilityConfig {
  orgId: string;

  // thresholds for SAIDI (hours)
  saidiWarningHours: number;
  saidiCriticalHours: number;

  // thresholds for SAIFI (interruptions per customer)
  saifiWarning: number;
  saifiCritical: number;

  // thresholds for CAIDI (hours)
  caidiWarningHours: number;
  caidiCriticalHours: number;

  // "MUTE" = no external alerts, just status
  // "LOG_ONLY" = keep inside PeakOps, no email/webhook yet
  // "ALERT" = later: external notifications allowed
  alertingMode: "MUTE" | "LOG_ONLY" | "ALERT";

  updatedAt: FirebaseFirestore.Timestamp;
  updatedBy: string;
}

// Alert doc when a metric crosses threshold
export interface ReliabilityAlert {
  orgId: string;
  metricId: string;
  regionId: string;
  year: number;

  saidiStatus: ReliabilityStatus;
  saifiStatus: ReliabilityStatus;
  caidiStatus: ReliabilityStatus;
  overallStatus: ReliabilityStatus;

  createdAt: FirebaseFirestore.Timestamp;
  createdBy: string; // "SYSTEM" for now
  source: string;    // e.g. "THRESHOLD_ENGINE"
}

export function makeMetricId(
  orgId: string,
  regionId: string,
  year: number,
  source: string
): string {
  return `${orgId}_${regionId}_${year}_${source}`.toUpperCase();
}
