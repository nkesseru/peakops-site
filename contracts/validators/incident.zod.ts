import { z } from "zod";
import { FilingTypes } from "../filings/filingTypes";

export const IncidentStatusZ = z.enum(["DRAFT", "ACTIVE", "MITIGATED", "CLOSED"]);

export const IncidentZ = z.object({
  id: z.string(),
  orgId: z.string(),

  title: z.string(),
  description: z.string().optional(),

  status: IncidentStatusZ,

  startTime: z.string(),
  detectedTime: z.string().optional(),
  resolvedTime: z.string().optional(),

  location: z.object({
    city: z.string().optional(),
    state: z.string().optional(),
    county: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
  }).optional(),

  affectedCustomers: z.number().optional(),

  filingTypesRequired: z.array(z.enum(FilingTypes)),

  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
});

export type IncidentValidated = z.infer<typeof IncidentZ>;
