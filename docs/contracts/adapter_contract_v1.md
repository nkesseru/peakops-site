# PeakOps Adapter Contract v1 (LOCKED)

This is the stable interface between:
- PeakOps core (SubmitQueue worker)
- Cloud Run filing adapters (DIRS, OE-417, NORS, etc.)

## Endpoints

### GET /health
200 JSON:
- ok: boolean
- service: string
- provider: string
- system: string
- version: string
- env: string
- timestamp: string (ISO)
- authEnabled: boolean

### POST /submit
Auth:
- Optional Bearer token (required if adapter has token configured)

Request body (minimum):
- orgId: string
- incidentId: string
- filingType: string (must equal the adapter’s system / filingType)
- payload: object
- correlationId?: string
- idempotencyKey?: string
- traceId?: string

Success response (LOCKED):
- ok: true
- provider: string
- system: string
- submissionMethod: "AUTO" | "MANUAL"
- confirmationId: string
- notes?: string
- correlationId?: string
- traceId?: string
- rawResponse?: object

Error response (LOCKED):
- ok: false
- error: string
- code?: string
- details?: object

## Versioning rules
- Any breaking change requires a NEW version (v2).
- v1 is locked for enterprise stability.
