# Punch List Template

Use this template for fast, reproducible bug tracking during demo hardening.

---

## Ticket
- ID:
- Title:
- Owner:
- Date:

## Severity
- Severity: `S0` | `S1` | `S2` | `S3`
- Priority: `P0` | `P1` | `P2`
- Area: `Incident` | `Jobs` | `Evidence` | `Review` | `Summary` | `Infra`

## Environment
- Build/branch:
- Runtime: `Emulator` | `Deployed`
- Project ID:
- Incident ID:
- Org ID:
- Browser/OS:

## Repro Steps
1.
2.
3.

## Expected vs Actual
- Expected:
- Actual:

## Evidence
- Screenshots/video:
- Console errors:
- Network/API errors (status + body):
- Relevant Firestore paths:
- Relevant Storage paths:

## Scope / Risk
- Affected users:
- Regression risk:
- Workaround available:

## Proposed Fix
- Files to change:
- Minimal patch plan:
- Server-side validation impact:

## Verification
- Manual test steps:
1.
2.
3.
- Smoke/automation checks:

## Resolution
- PR:
- Commit:
- Status: `Open` | `In Progress` | `Blocked` | `Fixed` | `Verified` | `Closed`
- Notes:

---

## Severity Guide
- `S0`: Demo/system unusable, no workaround.
- `S1`: Core flow broken, workaround exists but risky.
- `S2`: Important behavior wrong, non-blocking.
- `S3`: Cosmetic/minor annoyance.
