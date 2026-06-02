// Incident lifecycle state machine.
//
// Legacy flow (pre-PR 126):
//   open → in_progress → closed
//
// PR 126a — Customer Reviewer Link extends the state space with three
// additive states for the customer-review flow. Legacy `closed` keeps
// its semantics so existing records and the closeIncidentV1 path are
// unaffected.
//
//   open → in_progress → submitted_to_customer → customer_accepted   (terminal)
//                                              → customer_rejected
//                                              → in_progress         (revoke / cancel)
//          customer_rejected → in_progress           (route to rework)
//          customer_rejected → submitted_to_customer (re-send after fix)
//
// Operator display strings (PR 126a):
//   submitted_to_customer = "Awaiting customer review"
//   customer_accepted     = "Accepted by customer"
//   customer_rejected     = "Customer requested correction"
//   closed (legacy)       = "Accepted"

const INCIDENT_STATUS = Object.freeze({
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  CLOSED: "closed",
  // PR 126a — customer review flow
  SUBMITTED_TO_CUSTOMER: "submitted_to_customer",
  CUSTOMER_ACCEPTED: "customer_accepted",
  CUSTOMER_REJECTED: "customer_rejected",
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
  if (raw === INCIDENT_STATUS.IN_PROGRESS) return INCIDENT_STATUS.IN_PROGRESS;
  if (raw === INCIDENT_STATUS.CLOSED) return INCIDENT_STATUS.CLOSED;
  if (raw === INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER) return INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER;
  if (raw === INCIDENT_STATUS.CUSTOMER_ACCEPTED) return INCIDENT_STATUS.CUSTOMER_ACCEPTED;
  if (raw === INCIDENT_STATUS.CUSTOMER_REJECTED) return INCIDENT_STATUS.CUSTOMER_REJECTED;
  return INCIDENT_STATUS.OPEN;
}

function canTransitionIncident(fromStatus, toStatus) {
  const from = normalizeIncidentStatus(fromStatus);
  const to = normalizeIncidentStatus(toStatus);

  // Terminal states never transition.
  if (from === INCIDENT_STATUS.CLOSED) return to === INCIDENT_STATUS.CLOSED;
  if (from === INCIDENT_STATUS.CUSTOMER_ACCEPTED) return to === INCIDENT_STATUS.CUSTOMER_ACCEPTED;

  if (from === INCIDENT_STATUS.OPEN) {
    return (
      to === INCIDENT_STATUS.OPEN ||
      to === INCIDENT_STATUS.IN_PROGRESS ||
      to === INCIDENT_STATUS.CLOSED
    );
  }

  if (from === INCIDENT_STATUS.IN_PROGRESS) {
    return (
      to === INCIDENT_STATUS.IN_PROGRESS ||
      to === INCIDENT_STATUS.CLOSED ||
      // PR 126a — coordinator mints a customer-review link
      to === INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER
    );
  }

  if (from === INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER) {
    return (
      to === INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER ||
      // Customer terminal actions
      to === INCIDENT_STATUS.CUSTOMER_ACCEPTED ||
      to === INCIDENT_STATUS.CUSTOMER_REJECTED ||
      // Coordinator revoke / cancel before customer acts
      to === INCIDENT_STATUS.IN_PROGRESS
    );
  }

  if (from === INCIDENT_STATUS.CUSTOMER_REJECTED) {
    return (
      to === INCIDENT_STATUS.CUSTOMER_REJECTED ||
      // Route to rework
      to === INCIDENT_STATUS.IN_PROGRESS ||
      // Re-send after rework
      to === INCIDENT_STATUS.SUBMITTED_TO_CUSTOMER
    );
  }

  return false;
}

module.exports = {
  INCIDENT_STATUS,
  normalizeIncidentStatus,
  canTransitionIncident,
};
