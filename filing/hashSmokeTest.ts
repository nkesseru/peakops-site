import { IncidentZ } from "../contracts/validators/incident.zod";
import { generateFilingPackage } from "./generatePackage";
import { sha256OfObject } from "../utils/sha256";

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
const pkg = generateFilingPackage(incident, ["DOCUMENT"]);

const compliance = sha256OfObject(pkg.compliance).hash;
const dirs = sha256OfObject(pkg.draftsByType["DIRS"].payload).hash;

console.log(JSON.stringify({ complianceHash: compliance, dirsPayloadHash: dirs }, null, 2));
