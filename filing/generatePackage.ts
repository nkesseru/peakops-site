import { IncidentValidated } from "../contracts/validators/incident.zod";
import { FilingDraft } from "./types";
import { generateFilingDraft } from "./generateDraft";
import { runComplianceCheck } from "../validation/engine";

export interface FilingPackage {
  incidentId: string;
  orgId: string;
  generatedAt: string;
  generatorVersion: string;

  draftsByType: Record<string, FilingDraft>;
  compliance: ReturnType<typeof runComplianceCheck>;
}

export function generateFilingPackage(
  incident: IncidentValidated,
  evidenceTypesPresent: string[] = []
): FilingPackage {
  const draftsByType: Record<string, FilingDraft> = {};

  for (const type of incident.filingTypesRequired) {
    draftsByType[type] = generateFilingDraft(incident, type);
  }

  const compliance = runComplianceCheck(incident, evidenceTypesPresent);

  return {
    incidentId: incident.id,
    orgId: incident.orgId,
    generatedAt: new Date().toISOString(),
    generatorVersion: "v1",
    draftsByType,
    compliance,
  };
}
