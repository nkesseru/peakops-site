// PEAKOPS_ACCEPTANCE_READINESS_V1 (PR 103a)
//
// Deterministic projection of an incident's acceptance readiness from
// state PeakOps already records:
//
//   - incident.requirements          (PR 89a snapshot — required proof contract)
//   - evidence_locker[].requirementKey (PR 94a — operator-bound slot tags)
//   - jobs[].decision === "approved"   (per-task supervisor approval)
//   - incident.status === "closed"     (lifecycle gate)
//
// Output is a stateless projection — readiness IS the current data, so
// it's computed on demand and (optionally) cached on the incident doc
// for fast Records-page reads. The cache is a courtesy, not a source
// of truth — recompute any time and the answer must match.
//
// What this helper is NOT:
//   - Not AI / scoring / prediction / probability
//   - Not a percentage (counts only — never "67% ready")
//   - Not a per-customer policy engine (PR 104+ extension)
//   - Not a validation engine — only reports satisfied / unsatisfied
//   - Not opinionated about export gating; gating is the caller's call
//
// State labels (operational, not aspirational):
//   - "ready_for_submission"  : every REQUIRED check satisfied
//   - "requirements_missing"  : at least one REQUIRED check unsatisfied
//   - "not_available"         : no checks could be evaluated (legacy
//                               incident with no snapshot AND no
//                               evidence — can't compute meaningfully)
//
// Tier semantics:
//   - "required"   : must ALL be satisfied for "ready_for_submission"
//   - "encouraged" : reported but doesn't gate state (none in MVP;
//                    reserved for future PRs that add attestation /
//                    acknowledgment / notes)

// Mirrors next-app/AddEvidenceClient.tsx slugRequirement byte-for-byte
// AND the matching helper in exportIncidentPacketV1.js — keep these in
// sync if the algorithm ever changes. Backend regex
// ^[a-z0-9-]{1,120}$ stays satisfied.
function slugRequirement(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

/**
 * Compute acceptance readiness from raw incident state.
 *
 * @param {object} args
 * @param {object} args.incident   — incident doc (must include status,
 *                                   may include requirements snapshot)
 * @param {Array}  args.evidence   — array of evidence_locker docs
 * @param {Array}  args.jobs       — array of job docs
 * @returns {object} readiness projection (see shape below)
 */
function computeAcceptanceReadiness({ incident, evidence, jobs }) {
  const checks = [];

  // ─── REQUIRED PROOF CHECKS ────────────────────────────────────
  // One check per declared required-proof item. Satisfied when at
  // least one evidence doc carries the matching requirementKey.
  // A doc's requirementKey is trusted only if it passes the backend
  // regex (matches client/export slug derivation).

  const reqSnapshot =
    incident && incident.requirements && typeof incident.requirements === "object"
      ? incident.requirements
      : null;
  const reqLabels = reqSnapshot && Array.isArray(reqSnapshot.requiredProof)
    ? reqSnapshot.requiredProof.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
    : [];
  const reqSource = String(reqSnapshot?.source || "").trim() || "none";

  // Per-slot satisfaction lookup.
  const evidenceByKey = new Map();
  const evList = Array.isArray(evidence) ? evidence : [];
  for (const ev of evList) {
    const k = String(ev?.requirementKey || "").trim();
    if (!k || !/^[a-z0-9-]{1,120}$/.test(k)) continue;
    if (!evidenceByKey.has(k)) evidenceByKey.set(k, 0);
    evidenceByKey.set(k, evidenceByKey.get(k) + 1);
  }

  for (let i = 0; i < reqLabels.length; i++) {
    const label = reqLabels[i];
    const key = slugRequirement(label);
    const count = key ? (evidenceByKey.get(key) || 0) : 0;
    const satisfied = count > 0;
    checks.push({
      key: `required_proof__${key || `slot_${i + 1}`}`,
      label,
      category: "required_proof",
      tier: "required",
      satisfied,
      detail: satisfied
        ? `${count} ${count === 1 ? "photo" : "photos"} captured`
        : "No proof captured",
    });
  }

  // ─── SUPERVISOR APPROVAL CHECK ────────────────────────────────
  // Satisfied when at least one job decision === "approved".
  // approvedJob normalization mirrors exportIncidentPacketV1's
  // isApprovedJob — same set of accept signals.
  const jobList = Array.isArray(jobs) ? jobs : [];
  const approvedJobs = jobList.filter((j) => {
    const rs = String(j?.reviewStatus || "").trim().toLowerCase();
    const dec = String(j?.decision || "").trim().toLowerCase();
    return rs === "approved" || dec === "approved";
  });
  checks.push({
    key: "supervisor_approval",
    label: "Supervisor approval",
    category: "approval",
    tier: "required",
    satisfied: approvedJobs.length > 0,
    detail: approvedJobs.length > 0
      ? `${approvedJobs.length} of ${jobList.length} ${jobList.length === 1 ? "task" : "tasks"} approved`
      : "No tasks approved yet",
  });

  // ─── INCIDENT CLOSURE CHECK ───────────────────────────────────
  // Satisfied when incident.status === "closed". Sealed packets are
  // the only ones whose proof contract is final; an open incident
  // can still accrue new proof.
  const statusRaw = String(incident?.status || "").trim().toLowerCase();
  const isClosed = statusRaw === "closed";
  checks.push({
    key: "incident_closure",
    label: "Incident closure",
    category: "closure",
    tier: "required",
    satisfied: isClosed,
    detail: isClosed ? "Closed" : `Status: ${statusRaw || "(unknown)"}`,
  });

  // ─── LEGACY FALLBACK CHECK ────────────────────────────────────
  // Pre-PR-89a incidents have no requirements snapshot. We can't
  // evaluate per-slot satisfaction. Surface a single fallback check
  // — at least one evidence doc exists — so the incident's readiness
  // isn't an empty void.
  if (reqLabels.length === 0) {
    checks.push({
      key: "legacy_evidence_present",
      label: "At least one evidence doc",
      category: "required_proof",
      tier: "required",
      satisfied: evList.length > 0,
      detail: evList.length > 0
        ? `${evList.length} ${evList.length === 1 ? "evidence doc" : "evidence docs"}`
        : "No evidence captured",
    });
  }

  // ─── STATE COMPUTATION ────────────────────────────────────────
  const requiredChecks = checks.filter((c) => c.tier === "required");
  const encouragedChecks = checks.filter((c) => c.tier === "encouraged");
  const requiredSatisfied = requiredChecks.filter((c) => c.satisfied).length;
  const encouragedSatisfied = encouragedChecks.filter((c) => c.satisfied).length;

  // "not_available" — pre-PR-89a legacy incident with NO snapshot
  // AND no evidence. The legacy_evidence_present check is the only
  // required signal and it's unsatisfied; we can't say anything
  // meaningful about readiness without either proof or a contract.
  let state;
  if (reqLabels.length === 0 && evList.length === 0) {
    state = "not_available";
  } else if (requiredSatisfied === requiredChecks.length) {
    state = "ready_for_submission";
  } else {
    state = "requirements_missing";
  }

  return {
    readinessVersion: 1,
    state,
    generatedAt: new Date().toISOString(),
    requirementsSnapshotSource: reqLabels.length > 0 ? reqSource : "none",
    summary: {
      requiredSatisfied,
      requiredTotal: requiredChecks.length,
      encouragedSatisfied,
      encouragedTotal: encouragedChecks.length,
    },
    checks,
  };
}

module.exports = {
  computeAcceptanceReadiness,
  slugRequirement,  // exported so tests can verify shared logic
};
