// src/types/submission.ts

export type SubmissionStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "SUCCESS"
  | "FAILED";

export interface SubmissionQueueItem {
  orgId: string;
  incidentId: string;            // e.g. BUTLER-PUD_INC-1001
  filingType: "DIRS" | "OE417";  // extend later if needed

  status: SubmissionStatus;
  attempts: number;

  lastError?: string | null;

  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;

  // Payload we'll eventually send to FCC/DOE
  payload: any;
}
