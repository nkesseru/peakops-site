import { IncidentZ } from "../contracts/validators/incident.zod";
import { generateFilingDraft } from "./generateDraft";

const sample = {
  id: "inc_001",
  orgId: "org_001",
  title: "Windstorm outage - South District",
  status: "ACTIVE",
  startTime: new Date().toISOString(),
  filingTypesRequired: ["DIRS", "OE_417", "NORS", "SAR", "BABA"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdBy: "user_001",

  // intentionally missing some stuff; generator should still produce drafts
};

const incident = IncidentZ.parse(sample);

const drafts = incident.filingTypesRequired.map((t) => generateFilingDraft(incident, t));
console.log(JSON.stringify(drafts, null, 2));
