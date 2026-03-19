import { IncidentValidated } from "../contracts/validators/incident.zod";
import { FilingType } from "../contracts/filings/filingTypes";
import { FilingDraft } from "./types";
import { generateDIRSDraft } from "./generateDIRS";
import { generateOE417Draft } from "./generateOE417";

function stub(type: FilingType, incident: IncidentValidated): FilingDraft {
  return {
    type,
    payload: {
      filingType: type,
      incidentId: incident.id,
      orgId: incident.orgId,
      title: incident.title,
      startTime: incident.startTime,
      meta: { source: "peakops", schemaVersion: `${type.toLowerCase?.() ?? type}.v1` },
      note: "Stub draft (to be implemented).",
    },
    generatedAt: new Date().toISOString(),
    generatorVersion: "v1",
  };
}

export function generateFilingDraft(incident: IncidentValidated, type: FilingType): FilingDraft {
  switch (type) {
    case "DIRS":
      return generateDIRSDraft(incident);
    case "OE_417":
      return generateOE417Draft(incident);
    case "NORS":
    case "SAR":
    case "BABA":
      return stub(type, incident);
    default:
      return stub(type, incident);
  }
}
