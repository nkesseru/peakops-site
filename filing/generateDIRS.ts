import { IncidentValidated } from "../contracts/validators/incident.zod";
import { FilingDraft } from "./types";

export function generateDIRSDraft(incident: IncidentValidated): FilingDraft {
  // NOTE: Keep payload shape stable. We can map to official FCC fields later.
  const payload = {
    filingType: "DIRS",
    incidentId: incident.id,
    orgId: incident.orgId,

    title: incident.title,
    description: incident.description ?? "",

    startTime: incident.startTime,
    detectedTime: incident.detectedTime ?? null,
    resolvedTime: incident.resolvedTime ?? null,

    location: incident.location ?? null,

    affectedCustomers: incident.affectedCustomers ?? null,

    // versioned place for later agency-specific schema
    meta: {
      source: "peakops",
      schemaVersion: "dirs.v1",
    },
  };

  return {
    type: "DIRS",
    payload,
    generatedAt: new Date().toISOString(),
    generatorVersion: "v1",
  };
}
