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

  // intentionally missing:
  // affectedCustomers (DIRS requires)
  // location.state (OE-417 requires)
};

const incident = IncidentZ.parse(sample);

// Pretend only DOCUMENT evidence exists so DIRS LOG requirement triggers
const evidenceTypesPresent = ["DOCUMENT"];

const result = runComplianceCheck(incident, evidenceTypesPresent);
console.log(JSON.stringify(result, null, 2));
