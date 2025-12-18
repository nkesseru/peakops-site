export type EvidenceType =
  | "PHOTO"
  | "VIDEO"
  | "DOCUMENT"
  | "LOG"
  | "SCREENSHOT"
  | "OTHER";

export type EvidenceStatus =
  | "PENDING"
  | "AVAILABLE"
  | "MISSING"
  | "REDACTED";

export interface Evidence {
  id: string;
  orgId: string;
  incidentId: string;

  type: EvidenceType;
  status: EvidenceStatus;

  title?: string;
  description?: string;

  // Storage pointer (or external URL if needed)
  storage?: {
    bucket?: string;
    path?: string;
    contentType?: string;
    sizeBytes?: number;
  };
  externalUrl?: string;

  // Tamper-evidence / audit
  hash?: {
    algo: "SHA256";
    value: string;
  };

  // Evidence can be linked to specific filings/events
  links?: {
    filingIds?: string[];
    timelineEventIds?: string[];
  };

  capturedAt?: string; // when evidence was collected (client time ISO)
  uploadedAt?: string; // server time ISO
  uploadedBy?: string; // userId

  createdAt: string; // ISO
  updatedAt: string; // ISO
}
