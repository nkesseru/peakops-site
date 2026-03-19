import { FilingType } from "../filings/filingTypes";

export type IncidentStatus =
  | "DRAFT"
  | "ACTIVE"
  | "MITIGATED"
  | "CLOSED";

export interface Incident {
  id: string;
  orgId: string;

  title: string;
  description?: string;

  status: IncidentStatus;

  startTime: string; // ISO-8601
  detectedTime?: string;
  resolvedTime?: string;

  location?: {
    city?: string;
    state?: string;
    county?: string;
    lat?: number;
    lon?: number;
  };

  affectedCustomers?: number;

  filingTypesRequired: FilingType[];

  createdAt: string; // server timestamp ISO
  updatedAt: string; // server timestamp ISO

  createdBy: string; // userId
}
