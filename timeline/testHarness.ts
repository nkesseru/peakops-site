import { generateTimelineLevel1 } from "./generateTimeline";

const incident = {
  id: "inc_001",
  orgId: "org_001",
  title: "Windstorm outage - South District",
  startTime: new Date(Date.now() - 60_000).toISOString(),
};

const filings = [
  { id: "DIRS", type: "DIRS", status: "DRAFT", generatedAt: new Date().toISOString() },
  { id: "OE_417", type: "OE_417", status: "DRAFT", generatedAt: new Date().toISOString() },
];

const systemLogs = [
  { id: "log1", event: "filing.package.persisted", message: "Persisted filing drafts + hashes (Step 2.8)", createdAt: new Date().toISOString() },
];

const events = generateTimelineLevel1({ incident, filings, systemLogs });
console.log(JSON.stringify(events, null, 2));
