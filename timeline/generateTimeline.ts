import { TimelineEvent } from "../contracts/firestore/timelineEvent";

type FilingDoc = {
  id: string;
  type: string;
  status: string;
  generatedAt?: string;
  updatedAt?: string;
  createdAt?: string;
};

type SystemLogDoc = {
  id: string;
  event: string;
  message?: string;
  createdAt: string;
};

type IncidentLite = {
  id: string;
  orgId: string;
  title: string;
  startTime: string;
  detectedTime?: string;
  resolvedTime?: string;
};

function mkId(prefix: string, key: string) {
  return `${prefix}_${key}`.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

export function generateTimelineLevel1(input: {
  incident: IncidentLite;
  filings: FilingDoc[];
  systemLogs: SystemLogDoc[];
}): TimelineEvent[] {
  const { incident, filings, systemLogs } = input;

  const events: TimelineEvent[] = [];
  const now = new Date().toISOString();

  // Incident anchors
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

  // Filing draft events
  for (const f of filings) {
    const t = f.generatedAt ?? f.updatedAt ?? f.createdAt ?? now;
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

  // System logs as timeline notes (optional but powerful)
  for (const log of systemLogs) {
    events.push({
      id: mkId("evt", `log_${log.id}`),
      orgId: incident.orgId,
      incidentId: incident.id,
      type: "SYSTEM_NOTE",
      occurredAt: log.createdAt,
      title: log.event,
      message: log.message ?? "",
      links: { },
      source: "SYSTEM",
      createdAt: now,
    });
  }

  // Deterministic ordering
  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  return events;
}
