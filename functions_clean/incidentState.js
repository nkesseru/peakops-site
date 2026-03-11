const INCIDENT_STATUS = Object.freeze({
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  CLOSED: "closed",
});

function normalizeIncidentStatus(status) {
  const raw = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (raw === "in-progress" || raw === "inprogress" || raw === "submitted") {
    return INCIDENT_STATUS.IN_PROGRESS;
  }
  if (raw === INCIDENT_STATUS.OPEN) return INCIDENT_STATUS.OPEN;
  if (raw === INCIDENT_STATUS.CLOSED) return INCIDENT_STATUS.CLOSED;
  return INCIDENT_STATUS.OPEN;
}

function canTransitionIncident(fromStatus, toStatus) {
  const from = normalizeIncidentStatus(fromStatus);
  const to = normalizeIncidentStatus(toStatus);
  if (from === INCIDENT_STATUS.CLOSED) return to === INCIDENT_STATUS.CLOSED;
  if (from === INCIDENT_STATUS.OPEN) {
    return to === INCIDENT_STATUS.OPEN || to === INCIDENT_STATUS.IN_PROGRESS || to === INCIDENT_STATUS.CLOSED;
  }
  if (from === INCIDENT_STATUS.IN_PROGRESS) {
    return to === INCIDENT_STATUS.IN_PROGRESS || to === INCIDENT_STATUS.CLOSED;
  }
  return false;
}

module.exports = {
  INCIDENT_STATUS,
  normalizeIncidentStatus,
  canTransitionIncident,
};

