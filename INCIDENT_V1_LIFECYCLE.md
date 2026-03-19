- MUTABLE (default)
- IMMUTABLE (sealed)

- generateTimelineV1
- generateFilingsV1
- exportIncidentPacketV1
- read endpoints (bundle/meta/timeline/etc.)
- download zips
- verify zip (if not already persisted)
- exportIncidentPacketV1 ONLY with force=1 (admin override)
- Sets immutable=true, immutableAt, immutableBy (+ optional immutableReason)
- Writes timeline event: INCIDENT_FINALIZED
- After finalization, mutation routes must reject with IMMUTABLE error

- UI must reflect backend truth via getIncidentLockV1 + getZipVerificationV1.
