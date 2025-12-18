import { IncidentZ } from "../contracts/validators/incident.zod";
import { runComplianceCheck } from "./engine";

const sample = {
  id: "inc_001",
  orgId: "org_001",
  title: "Windstorm outage - South District",
  status: "ACTIVE",
  startTime: new Date().toISOString(),
  filingTypesRequired: ["DIRS", "OE_417"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdBy: "user_001",
};

const incident = IncidentZ.parse(sample);
const result = runComplianceCheck(incident);

console.log(JSON.stringify(result, null, 2));
