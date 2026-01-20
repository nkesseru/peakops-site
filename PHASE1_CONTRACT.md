# PeakOps Phase-1 Contract (Frozen)

## Canonical Sources of Truth
- Workflow: getWorkflowV1
- Timeline: getTimelineEventsV1
- Filings: generateFilingsV1
- Packet Meta: getIncidentPacketMetaV1
- ZIP Artifact: downloadIncidentPacketZip
- ZIP Verified: getZipVerificationV1
- Immutable Lock: getIncidentLockV1

## UI Rules (Non-Negotiable)
- UI NEVER infers state
- UI NEVER derives truth from ZIP headers
- UI ONLY reflects API endpoints
- UI must survive missing / null data
- UI must not crash if any endpoint fails

## Mutation Rules
### Allowed BEFORE immutable:
- generateTimelineV1
- generateFilingsV1
- downloadIncidentPacketZip
- persistZipVerificationV1
- finalizeIncidentV1

### Allowed AFTER immutable:
- downloadIncidentPacketZip
- get* endpoints ONLY

## Artifact Rules
- ZIP download is the canonical artifact
- exportIncidentPacketV1 is OPTIONAL / best-effort
- PacketMeta may be null and that is acceptable

## Invariants
- Immutable means NO data mutation
- ZIP Verified is independent of workflow
- PacketMeta is informational, not authoritative
