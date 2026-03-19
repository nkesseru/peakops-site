# Contract Packets

## Contract Build A (Regulatory Packet)

Canonical, deterministic export attached to an incident.

Includes:
- filings JSON + filings_meta
- timeline JSON + timeline_meta
- submit queue jobs JSON
- logs (system / filing / user)
- evidence locker JSON (request + response)
- manifest + packet hash + README

This is the baseline. Keep it green. No feature creep.

---

## Contract Build B (Contract Packet)

Enterprise extension layer.

It:
- runs Contract Build A
- adds: contract/contract.json
- repacks into a new ZIP (“contract packet”)

Additive only.

---

## Concepts

An **incident** is the root object (orgId + incidentId).

Everything hangs off it:
- filings (DIRS / NORS / OE_417 / SAR / BABA)
- timeline events
- submission jobs
- evidence locker records
- exportable packets

Evidence Locker is append-only:
- SUBMISSION_REQUEST
- SUBMISSION_RESPONSE
- (future) WORKER_EVENT / USER_ACTION / SYSTEM_EVENT

Each record includes:
- payload preview
- byte size + truncation flag
- SHA256 hash
- timestamp
- filingType + jobId
