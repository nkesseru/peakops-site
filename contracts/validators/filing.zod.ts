import { z } from "zod";
import { FilingTypes } from "../filings/filingTypes";

export const FilingStatusZ = z.enum([
  "DRAFT",
  "READY",
  "SUBMITTED",
  "ACCEPTED",
  "REJECTED",
  "AMENDED",
  "CANCELLED",
]);

export const FilingZ = z.object({
  id: z.string(),
  orgId: z.string(),
  incidentId: z.string(),

  type: z.enum(FilingTypes),
  status: FilingStatusZ,

  payload: z.record(z.unknown()),

  compliance: z.object({
    isCompliant: z.boolean(),
    missingFields: z.array(z.string()).optional(),
    missingEvidence: z.array(z.string()).optional(),
    flags: z.array(z.string()).optional(),
    ranAt: z.string(),
    ranBy: z.string(),
  }).optional(),

  submittedAt: z.string().optional(),
  submittedBy: z.string().optional(),

  external: z.object({
    agency: z.enum(["FCC", "DOE", "OTHER"]).optional(),
    confirmationId: z.string().optional(),
    submissionMethod: z.enum(["MANUAL", "API", "UPLOAD"]).optional(),
  }).optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
});

export type FilingValidated = z.infer<typeof FilingZ>;
