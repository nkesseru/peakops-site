import { FilingType } from "../filings/filingTypes";

export type FilingStatus =
  | "DRAFT"
  | "READY"
  | "SUBMITTED"
  | "ACCEPTED"
  | "REJECTED"
  | "AMENDED"
  | "CANCELLED";

export interface Filing {
  id: string;
  orgId: string;
  incidentId: string;

  type: FilingType;
  status: FilingStatus;

  // Filing-ready JSON output (what we generate)
  payload: Record<string, unknown>;

  // Validation + compliance results snapshots
  compliance?: {
    isCompliant: boolean;
    missingFields?: string[];
    missingEvidence?: string[];
    flags?: string[];
    ranAt: string; // ISO
    ranBy: string; // userId or "system"
  };

  submittedAt?: string; // ISO
  submittedBy?: string; // userId
  external?: {
    agency?: "FCC" | "DOE" | "OTHER";
    confirmationId?: string;
    submissionMethod?: "MANUAL" | "API" | "UPLOAD";
  };

  createdAt: string; // ISO
  updatedAt: string; // ISO
  createdBy: string; // userId
}
