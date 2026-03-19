import { IncidentValidated } from "../contracts/validators/incident.zod";
import { FilingDraft } from "./types";

export function generateOE417Draft(incident: IncidentValidated): FilingDraft {
  const payload = {
    filingType: "OE_417",
    incidentId: incident.id,
    orgId: incident.orgId,

    title: incident.title,
    description: incident.description ?? "",

    startTime: incident.startTime,
    detectedTime: incident.detectedTime ?? null,
    resolvedTime: incident.resolvedTime ?? null,

    location: incident.location ?? null,

    // OE-417 tends to want classification + impact; placeholders for now
    impacts: {
      affectedCustomers: incident.affectedCustomers ?? null,
    },

    meta: {
      source: "peakops",
      schemaVersion: "oe417.v1",
    },
  };

  return {
    type: "OE_417",
    payload,
    generatedAt: new Date().toISOString(),
    generatorVersion: "v1",
  };
}
