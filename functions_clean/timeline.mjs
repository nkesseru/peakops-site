import { sha256OfObject } from "./audit.mjs";

function mkId(prefix, key) {
  return `${prefix}_${key}`.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

export function generateTimelineLevel1({ incident, filings, systemLogs, userLogs = [], filingLogs = [] }) {
  const now = new Date().toISOString();
  const events = [];

  events.push({
    id: mkId("evt", "incident_start"),
    orgId: incident.orgId,
    incidentId: incident.id,
    type: "OUTAGE_START",
    occurredAt: incident.startTime,
    title: "Incident started",
    message: incident.title,
    source: "SYSTEM",
    createdAt: now,
  });

  if (incident.detectedTime) {
    events.push({
      id: mkId("evt", "incident_detected"),
      orgId: incident.orgId,
      incidentId: incident.id,
      type: "OUTAGE_UPDATE",
      occurredAt: incident.detectedTime,
      title: "Incident detected",
      message: "Detected time recorded",
      source: "SYSTEM",
      createdAt: now,
    });
  }

  if (incident.resolvedTime) {
    events.push({
      id: mkId("evt", "incident_resolved"),
      orgId: incident.orgId,
      incidentId: incident.id,
      type: "OUTAGE_RESTORED",
      occurredAt: incident.resolvedTime,
      title: "Incident resolved",
      message: "Resolved time recorded",
      source: "SYSTEM",
      createdAt: now,
    });
  }

  for (const f of filings) {
    const t = f.generatedAt || f.updatedAt || f.createdAt || now;
    events.push({
      id: mkId("evt", `filing_${f.type}_draft`),
      orgId: incident.orgId,
      incidentId: incident.id,
      type: "FILING_GENERATED",
      occurredAt: t,
      title: `Filing draft generated: ${f.type}`,
      message: `Status: ${f.status}`,
      links: { filingId: f.id },
      source: "SYSTEM",
      createdAt: now,
    });
  }

  for (const log of systemLogs) {
    events.push({
      id: mkId("evt", `syslog_${log.id}`),
      orgId: incident.orgId,
      incidentId: incident.id,
      type: "SYSTEM_NOTE",
      occurredAt: log.createdAt || now,
      title: log.event || "system.log",
      message: log.message || "",
      source: "SYSTEM",
      createdAt: now,
    });
  }

  for (const u of userLogs) {
    events.push({
      id: mkId("evt", `user_${u.id}`),
      orgId: u.orgId || incident.orgId,
      incidentId: incident.id,
      type: "USER_NOTE",
      occurredAt: u.createdAt || now,
      title: u.action || "user.action",
      message: u.message || "",
      links: { userId: u.userId || "" },
      source: "USER",
      createdAt: now,
    });
  }

  for (const f of filingLogs) {
    const filingType = f.filingType || "UNKNOWN";
    const action = f.action || "action";
    events.push({
      id: mkId("evt", `filingaction_${f.id}`),
      orgId: f.orgId || incident.orgId,
      incidentId: incident.id,
      type: "FILING_SUBMITTED",
      occurredAt: f.createdAt || now,
      title: `Filing ${filingType}: ${action}`,
      message: f.message || "",
      links: { filingId: filingType, userId: f.userId || "" },
      source: (f.userId && f.userId !== "system") ? "USER" : "SYSTEM",
      createdAt: now,
    });
  }

  events.sort((a, b) => (a.occurredAt || "").localeCompare(b.occurredAt || "") || a.id.localeCompare(b.id));

  const timelineHash = sha256OfObject(events).hash;
  return { events, timelineHash, generatedAt: now };
}
