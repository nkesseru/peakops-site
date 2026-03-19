# PeakOps Incident V1 – Field Tech Runbook (MVP)

## Goal
A field tech can:
1) Confirm incident status
2) Generate required filings + timeline
3) Export packet + verify ZIP
4) Finalize incident (immutable) and prove integrity

## Flow
1. **Incident page**
   - Generate Timeline
   - Generate Filings
   - Export Packet
   - Open Artifact

2. **Artifact page**
   - Verify ZIP ✅ (persisted)
   - Load File Tree (sanity check manifest/hashes)
   - Finalize Incident ✅ (immutable)

## Immutable rules
- After Finalize, all mutation endpoints must return **409 IMMUTABLE** (unless `force=1`).
- Downloads and reads remain enabled.

## “Prove it” buttons (MVP)
- Copy packetHash
- Download Packet ZIP
- Verify ZIP

## UI notes
- Show a green banner when immutable is true.
- Disable mutation buttons when immutable.
- Keep ZIP Verified + Immutable badges sticky after hard refresh.
