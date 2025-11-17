// src/types/jobDetailView.ts

export interface JobDetailView {
  jobId: string;
  orgId: string;

  // job core
  status?: string;
  workOrderId?: string;
  ptpId?: string;
  scheduledStart?: FirebaseFirestore.Timestamp | null;
  scheduledEnd?: FirebaseFirestore.Timestamp | null;
  crewAssigned?: string | null;

  // location snapshot
  locationId?: string | null;
  locationName?: string | null;
  locationAddress?: string | null;
  locationCity?: string | null;
  locationState?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;

  // optional rolled-up bits
  lastInspectionAt?: FirebaseFirestore.Timestamp | null;
  openIssuesCount?: number | null;
  notesPreview?: string | null;

  updatedAt: FirebaseFirestore.Timestamp;
}
