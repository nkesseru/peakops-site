export type SystemLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface SystemLog {
  id: string;
  orgId?: string;
  incidentId?: string;

  level: SystemLogLevel;
  event: string; // e.g. "compliance.check.ran"
  message?: string;

  context?: Record<string, unknown>;

  actor?: {
    type: "SYSTEM" | "USER" | "INGEST";
    userId?: string;
  };

  createdAt: string; // ISO
}
