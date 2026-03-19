export type TimelineEventType =
  | "OUTAGE_START"
  | "OUTAGE_UPDATE"
  | "OUTAGE_RESTORED"
  | "EVIDENCE_ADDED"
  | "FILING_REQUIRED"
  | "FILING_GENERATED"
  | "FILING_SUBMITTED"
  | "USER_NOTE"
  | "SYSTEM_NOTE";

export interface TimelineEvent {
  id: string;
  orgId: string;
  incidentId: string;

  type: TimelineEventType;

  // Primary time used for ordering
  occurredAt: string; // ISO

  // Secondary metadata for grouping / display
  title?: string;
  message?: string;

  // Links
  links?: {
    evidenceId?: string;
    filingId?: string;
    userId?: string;
  };

  // Source attribution
  source: "USER" | "SYSTEM" | "INGEST";
  createdAt: string; // ISO
}
