import { IncidentZ } from "../contracts/validators/incident.zod";
import { generateFilingPackage } from "./generatePackage";

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
};

const incident = IncidentZ.parse(sample);

// Pretend only DOCUMENT evidence exists so DIRS LOG requirement triggers
const evidenceTypesPresent = ["DOCUMENT"];

const pkg = generateFilingPackage(incident, evidenceTypesPresent);
console.log(JSON.stringify(pkg, null, 2));
