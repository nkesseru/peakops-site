// src/types/telecom.ts

export type TelecomIngestStatus = "ACCEPTED" | "REJECTED";

export interface TelecomIncident {
  orgId: string;
  incidentId: string;         // deterministic doc id (org + ticketId)
  ticketId: string;
  source: string;             // e.g. "BUTLER_EXPORT"
  status: "OPEN" | "RESOLVED";

  outageStart: FirebaseFirestore.Timestamp;
  outageEnd: FirebaseFirestore.Timestamp | null;

  state: string | null;
  county: string | null;
  customersAffected: number | null;
  description: string | null;

  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
  importedBy: string;
}

export interface TelecomIngestRaw {
  orgId: string;
  rawRow: any;
  parsed: Partial<TelecomIncident> | null;
  status: TelecomIngestStatus;
  errorCode?: string;
  errorMessage?: string;
  importedAt: FirebaseFirestore.Timestamp;
  importedBy: string;
  source: string;
}

// Simple deterministic ID: org + ticket
export function makeTelecomIncidentId(orgId: string, ticketId: string): string {
  return `${orgId}_${ticketId}`.toUpperCase();
}
