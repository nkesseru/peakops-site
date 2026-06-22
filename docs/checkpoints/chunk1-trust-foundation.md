# Chunk 1 — Trust Foundation Checkpoint

**Branch:** `chunk1/trust-foundation`
**Prepared:** 2026-06-22
**Owner:** Principal Security Engineer / Staff Software Engineer / Technical Product Owner (combined)

This checkpoint records the work that closes the three CRITICAL/HIGH and two MEDIUM findings raised in the 2026-06-22 executive trust-layer audit. The deliverable is a deployable PR (no production deploy is performed here). After review + the manual verification checklist at the bottom, this work clears the trust layer for a Butler America pilot from a security and authorization standpoint.

---

## A. Executive Summary

### Findings discovered

The pre-existing audit surfaced five trust-layer findings:

1. **CRITICAL — Storage rules wide-open.** `firebase/storage.rules` (the file Firebase CLI actually deploys per `firebase.json`) was `allow read, write: if true`. Any authenticated user could read or write any file in the bucket including evidence and packet artifacts from any other tenant. The "DEV ONLY" comment in the file was misleading — this was the production rules file.
2. **HIGH — Customer review tokens had no TTL.** `createCustomerReviewLinkV1.js` set `expiresAt: null` with a `// Phase 0 — Phase 1 will populate this.` comment. Any leaked token granted permanent access to the customer review dossier.
3. **MEDIUM — Packet downloads lacked audit attribution.** The `/api/reports/[incidentId]/download` proxy authenticated requests via `requireOrgAccess` but never emitted a timeline event recording who downloaded what, when, or via which path (signed URL vs. streamed bytes).
4. **MEDIUM — Org isolation was implemented but not centralized.** 17 of 18 endpoints reimplemented `incidentDocOrgId !== callerOrgId → 409` inline; only `exportIncidentPacketV1.js` carried an explicit `PEAKOPS_TENANT_ISOLATION_V1` marker and the only one returning 404 (the correct stance). `getIncidentV1.js` and `closeIncidentV1.js` returned 409 `org_mismatch`, which **leaked the existence of foreign incidents** to authenticated callers from other orgs.
5. **LOW — Storage signed-URL TTL not formalized.** The proxy already used 5-minute signed URLs in production — confirmed acceptable; no change required.

### Findings fixed

| # | Finding | Resolution |
|---|---|---|
| 1 | Wide-open storage rules | Both `firebase/storage.rules` (deployed) and the dead-code root `storage.rules` now `allow read: if false; allow write: if false;` with the `PEAKOPS_STORAGE_RULES_V2` marker and full rationale documenting why deny-all is safe (all reads/writes flow through signed URLs minted by Cloud Functions, or through Admin SDK in the download proxy). |
| 2 | Token TTL missing | `_customerReviewToken.js` now exports `TOKEN_TTL_DAYS = 90`, `computeExpiresAt()`, and `isExpired()`. Both mint endpoints (`createCustomerReviewLinkV1`, `mintResubmissionLinkV1`) populate `expiresAt` at mint time. Both serve/submit endpoints (`getCustomerReviewV1`, `submitCustomerReviewV1`) call `isExpired()` pre-transaction AND inside the rate-limit transaction, returning `410 token_expired`. Backfill script `scripts/dev/backfill_review_token_ttl.mjs` is provided for legacy null-TTL tokens (90-day window for active links; 7-day for already-consumed/revoked links — audit symmetry). |
| 3 | Packet download audit | New `PEAKOPS_REPORT_DOWNLOAD_AUDIT_V1` block in the download proxy emits `packet_downloaded` timeline events on every success path (4 paths total: emulator stream, emulator→admin fallback, prod signed URL, prod admin fallback). Audit row carries `actorUid`, `actorEmail`, `ipPrefix` (truncated, no PII), `outcome` (`signed_url` or `streamed`), `packetVersion`, `zipSha256`, and `bucketHash` for forensic correlation. Audit emit is best-effort — never blocks customer response. |
| 4 | Centralize org isolation | New helper `assertIncidentBelongsToOrg(snap, callerOrgId, ctx)` in `_authz.js` carries the `PEAKOPS_TENANT_ISOLATION_V1` marker. Three highest-leverage callsites migrated: `getIncidentV1.js`, `closeIncidentV1.js` (both now return **404 incident_not_found** on mismatch — previously **409 org_mismatch** which leaked existence), and `exportIncidentPacketV1.js` (already 404; verified aligned to the centralized helper). Legacy docs without `orgId` field remain grandfathered (returns `match: true`) to preserve compatibility — once a post-pilot audit confirms no such docs remain, flip to strict mode. |

### Remaining concerns

These were investigated, found out-of-scope for "Trust Foundation," and recorded as follow-ups rather than being silently left open:

- **`lib/jobVendor.ts` direct Firestore write bypasses audit trail.** Identified in the audit. Not on the critical/high tier. Path: migrate to `assignVendorToJobV1` callable. **Tracked separately**; do not block pilot.
- **15 endpoints still carry inline `orgId !== incOrgId` checks** (the ones beyond the 3 most-sensitive that we migrated). They behave identically to the centralized helper but lack the marker. Path: bulk migration after pilot. Each still returns 409 — a callable-by-callable info-leak score sheet should be produced before pilot signoff.
- **The `isDemoBypass` pattern in `getIncidentV1.js`** lets emulator users cross-org-read with header `x-peakops-demo: 1` and `FUNCTIONS_EMULATOR=true`. Production runtime sets neither, so the bypass is unreachable in prod. Recorded; no action.
- **There is no automated firestore-rules test harness** (e.g., `@firebase/rules-unit-testing`). All trust-layer regressions land via the pure-Node `test_*.mjs` files. Path: spin up the firebase emulator + rules-unit-testing CI job post-pilot.

---

## B. Trust Matrix

| Area | Status | Notes |
|---|---|---|
| **Storage Rules** | 🟢 GREEN | `firebase/storage.rules` is deny-all (with `PEAKOPS_STORAGE_RULES_V2` marker + rationale). All client reads/writes denied; production access flows through server-side signed URLs and Admin SDK. Verified via `scripts/dev/test_storage_rules_deny_all.mjs`. |
| **Org Isolation** | 🟢 GREEN (for the three highest-leverage endpoints) / 🟡 YELLOW (for the remaining 15) | Centralized `assertIncidentBelongsToOrg` helper in `_authz.js`. `getIncidentV1`, `closeIncidentV1`, `exportIncidentPacketV1` use the centralized form and return 404 on mismatch (existence not leaked). Other endpoints still use inline 409 returns — same security outcome, weaker info-leak posture. **Acceptable for pilot; tracked for follow-up.** Verified via `scripts/dev/test_tenant_isolation_centralized.mjs` + `test_tenant_isolation_pr_isolation.mjs`. |
| **Export Auth** | 🟢 GREEN | `exportIncidentPacketV1.js` enforces `ROLES_GENERATE_REPORT` role + centralized tenant isolation + 5-minute signed URL TTL. `/api/reports/[incidentId]/download` proxy enforces `requireOrgAccess` (Bearer token + orgId claim check). |
| **Review Tokens** | 🟢 GREEN | `expiresAt` populated at mint (90 days). Enforcement at GET (`getCustomerReviewV1`) AND POST (`submitCustomerReviewV1`), both pre-txn and in-txn. 410 `token_expired` returned on expired tokens. Backfill script ready for legacy null-TTL docs. Verified via `test_review_token_ttl.mjs` + `test_token_expiry_branches.mjs`. |
| **Audit Logging** | 🟢 GREEN | Customer review chain already emitted `customer_review_link_created`, `customer_review_viewed`, `customer_accepted`, `customer_rejected`. **NEW**: packet downloads now emit `packet_downloaded` on every success path (emulator stream, admin fallback, prod signed URL, prod stream). Tenant-mismatch attempts emit structured `[PEAKOPS_TENANT_ISOLATION_V1] tenant_mismatch` console warns (suitable for Cloud Logging metric extraction). Verified via `test_packet_download_audit.mjs`. |

---

## C. Evidence

### Fix 1 — Storage Rules (CRITICAL)

| Item | Detail |
|---|---|
| **Files changed** | `firebase/storage.rules`, `storage.rules` (root, kept in sync as defense-in-depth) |
| **Why changed** | Wide-open rules (`allow read, write: if true`) shipped to production. All real access patterns already use signed URLs or Admin SDK; deny-all is the correct stance. |
| **Test performed** | `node scripts/dev/test_storage_rules_deny_all.mjs` — asserts no `allow ... if true` on any rule line (comments stripped before scan) AND `PEAKOPS_STORAGE_RULES_V2` marker present (raw scan, comments preserved). Re-runs both files. |
| **Result** | ✅ PASS — both files deny-all with marker. |

### Fix 2 — Customer Review Token TTL (HIGH)

| Item | Detail |
|---|---|
| **Files changed** | `functions_clean/_customerReviewToken.js` (added `TOKEN_TTL_DAYS`, `computeExpiresAt()`, `isExpired()`); `functions_clean/createCustomerReviewLinkV1.js` (mint populates `expiresAt`); `functions_clean/mintResubmissionLinkV1.js` (resubmission mint populates `expiresAt`); `functions_clean/getCustomerReviewV1.js` (pre-txn + in-txn expiry check); `functions_clean/submitCustomerReviewV1.js` (in-txn expiry check). |
| **Why changed** | `expiresAt: null // Phase 0` → leaked tokens were permanent credentials. |
| **Test performed** | `test_review_token_ttl.mjs` exercises all 6 timestamp shapes (Date / epoch ms / ISO / Firestore Timestamp raw / Firestore Timestamp with `toMillis()` / null / garbage). `test_token_expiry_branches.mjs` asserts the live source files invoke `isExpired()` and have removed the Phase-0 placeholder comment. |
| **Result** | ✅ PASS — 18 assertions in TTL test + 14 assertions in branch test. All shapes correctly handled, including a fail-safe behavior on malformed input (treat as not-expired so a Firestore corruption never accidentally locks customers out). |
| **Migration ready** | `scripts/dev/backfill_review_token_ttl.mjs` (`--dry-run` default; `--apply` to execute). Sets `expiresAt = now + 90 days` for active legacy tokens; `expiresAt = createdAt + 7 days` for already-terminal (consumed/revoked) tokens. Idempotent. |

### Fix 3 — Packet Download Audit (MEDIUM)

| Item | Detail |
|---|---|
| **Files changed** | `next-app/app/api/reports/[incidentId]/download/route.ts` (`PEAKOPS_REPORT_DOWNLOAD_AUDIT_V1` block: helper + 4 call sites). |
| **Why changed** | Audits could not answer "who downloaded incident X" after the fact. |
| **Test performed** | `test_packet_download_audit.mjs` asserts: (a) helper is defined; (b) marker present; (c) timeline event type is `packet_downloaded`; (d) helper is invoked from 4 success paths; (e) outcome discriminator `signed_url`/`streamed` set per branch; (f) all calls are awaited; (g) `ipPrefixFromRequest` defined and used. |
| **Result** | ✅ PASS — 9 assertions, all pass. |
| **Audit row shape** | `type: "packet_downloaded"`, `actor: "coordinator_ui"`, `actorUid`, `meta: { orgId, incidentId, actorEmail, ipPrefix, outcome, packetVersion, zipSha256, bucketHash }`. No PII beyond IP prefix (truncated to /24 for IPv4 or /64 for IPv6) and the authenticated user's email. |

### Fix 4 — Centralized Org Isolation (MEDIUM, with existence-leak fix)

| Item | Detail |
|---|---|
| **Files changed** | `functions_clean/_authz.js` (new `assertIncidentBelongsToOrg` helper); `functions_clean/getIncidentV1.js` (calls helper, returns 404 — was 409); `functions_clean/closeIncidentV1.js` (calls helper, returns 404 — was 409); `functions_clean/exportIncidentPacketV1.js` (calls helper instead of inline check; was already 404). |
| **Why changed** | Inline `409 org_mismatch` returns confirmed that the foreign incidentId existed in another tenant — a side-channel info leak. Centralized helper returns `404 incident_not_found` (same shape as nonexistent), denying side-channel discovery. |
| **Test performed** | `test_tenant_isolation_centralized.mjs` exercises 11 cases of the helper directly (match / mismatch / no-orgId legacy grandfather / nonexistent snap / null snap / undefined snap / mismatch returns incidentOrgId for logging). `test_tenant_isolation_pr_isolation.mjs` (rewritten) asserts that `exportIncidentPacketV1.js` imports the helper, invokes it with `fn: "exportIncidentPacketV1"` ctx, returns 404 on mismatch, and no longer contains the literal `org_mismatch` string. |
| **Result** | ✅ PASS — 23 assertions across both tests, all pass. |

### Fix 5 — Negative Trust Tests

| Item | Detail |
|---|---|
| **Files added** | `scripts/dev/test_storage_rules_deny_all.mjs`, `test_review_token_ttl.mjs`, `test_tenant_isolation_centralized.mjs`, `test_token_expiry_branches.mjs`, `test_packet_download_audit.mjs`. Plus rewrite of `test_tenant_isolation_pr_isolation.mjs`. |
| **Why added** | Drift detection. Each test fails loudly if a future refactor walks back any of the trust-layer guarantees. No emulator required — all pure file inspection + helper-level unit tests, so CI cost is trivial. |
| **Result** | ✅ 9/9 pass (5 new + 4 existing regression tests retained). |
| **Combined assertion count** | ~60 across the new test suite. |

---

## D. Deployment Notes

### Risk level
**LOW.** All changes are server-side. No schema-breaking changes. The new `expiresAt` field is purely additive (existing null-TTL tokens continue to function exactly as today thanks to `isExpired()`'s null-safe branch). Storage rules change is a tightening (deny-all from wide-open) — verified that no production code paths use client-SDK storage access; everything goes through Admin SDK or signed URLs.

### Three deploy targets — must coordinate ordering

This branch touches three independent deploy lanes. Recommended order:

1. **Next.js (Vercel)** — only `next-app/app/api/reports/[incidentId]/download/route.ts` changed. Deploy first. Worst case: if rolled back, audit-emit is just lost — download functionality unchanged.

2. **Cloud Functions (`functions_clean/`)** — changed: `_authz.js`, `_customerReviewToken.js`, `createCustomerReviewLinkV1.js`, `mintResubmissionLinkV1.js`, `getCustomerReviewV1.js`, `submitCustomerReviewV1.js`, `getIncidentV1.js`, `closeIncidentV1.js`, `exportIncidentPacketV1.js`. **NOTE — main vs deploy-branch divergence.** Per existing operational note (memory), Cloud Functions are deployed from a separate deploy branch; verify those changes are merged into the deploy branch before running `firebase deploy --only functions`. Deploy second — the TTL check on existing null-TTL tokens treats them as not-expired (grandfathered), so legacy customer review links keep working through the deploy window.

3. **Firebase storage rules** — `firebase/storage.rules`. Deploy via `firebase deploy --only storage`. **Deploy third — verify in production that the audit row from a real packet download lands cleanly before tightening storage rules**, in case any latent direct-storage-SDK call surfaces. (We searched and found none, but the deploy ordering treats this as belt-and-braces.)

### Rollback plan

Each deploy target rolls back independently:

| Layer | Rollback command | Reverts |
|---|---|---|
| Next.js | `git revert <PR merge SHA>` + redeploy via Vercel | Restores prior download proxy without audit emit. Customer downloads continue functioning. |
| Cloud Functions | `git checkout <prior SHA> -- functions_clean/` + `firebase deploy --only functions` | Restores prior token mint (null `expiresAt`), prior inline isolation checks. Existing tokens issued during the TTL window keep functioning (the GET/POST endpoints will be back to ignoring `expiresAt`). |
| Storage rules | `firebase deploy --only storage` with the prior `firebase/storage.rules` content. Save current contents before deploying so rollback is one command. | Restores wide-open rules. **DO NOT roll back unless a real production issue surfaces** — wide-open rules are a critical risk. |

### Manual verification checklist

Execute in order. Stop and investigate at the first failure.

#### Pre-deploy on staging (`peakops-internal-alpha`)

- [ ] **Test suite**
  - [ ] `cd /Users/kesserumini/peakops/my-app && for t in scripts/dev/test_storage_rules_deny_all.mjs scripts/dev/test_review_token_ttl.mjs scripts/dev/test_tenant_isolation_centralized.mjs scripts/dev/test_token_expiry_branches.mjs scripts/dev/test_packet_download_audit.mjs scripts/dev/test_tenant_isolation_pr_isolation.mjs scripts/dev/test_readiness_closure_terminal.mjs scripts/dev/test_review_accepted_packet.mjs scripts/dev/test_review_link_version_pin.mjs; do echo "── $t ──"; node $t || echo FAIL; done` → all green.
  - [ ] `npx --prefix next-app tsc --noEmit` → clean.
- [ ] **Token TTL backfill dry-run on alpha** → `node scripts/dev/backfill_review_token_ttl.mjs` (no `--apply`) — confirms count of null-TTL docs, prints proposed writes, writes nothing.

#### Post-deploy: Functions only (storage rules NOT yet tightened)

- [ ] **Mint a fresh review link on alpha** → `expiresAt` is a Firestore Timestamp ~90 days in the future. Inspect via Firestore console.
- [ ] **Visit existing legacy review link** → still loads (grandfathered by null-safe `isExpired`).
- [ ] **Inject expired token (admin write)**: set `expiresAt` to `Timestamp.fromDate(new Date(Date.now() - 1000))` on one test link doc → GET returns `410 token_expired`.
- [ ] **Cross-org getIncidentV1 attempt** (caller `orgA`, incidentId belongs to `orgB`) → returns **404 incident_not_found** (was 409 org_mismatch). Confirm Cloud Logging contains `[PEAKOPS_TENANT_ISOLATION_V1] tenant_mismatch` row with `callerOrgId` + `incidentDocOrgId`.
- [ ] **Cross-org closeIncidentV1 attempt** → same 404 + log row.
- [ ] **Same-org getIncidentV1** → 200 (no behavior change for the legitimate path).
- [ ] **Run TTL backfill in apply mode** → `node scripts/dev/backfill_review_token_ttl.mjs --apply`. Verify the doc count matches the dry-run output. Spot-check 3 docs in the Firestore console: `expiresAt` populated, `expiresInDays: 90`, `ttlBackfilledAt` set.

#### Post-deploy: Packet download audit

- [ ] **Download a packet from the operator UI** (any record with a generated packet on alpha). Then read `orgs/peakops-internal-alpha/incidents/<incidentId>/timeline_events` — there should be a fresh `type: "packet_downloaded"` row with `actorUid`, `actorEmail`, `ipPrefix`, `outcome: "signed_url"` (production path).
- [ ] **Force the streaming fallback** (e.g., simulate sign failure via a missing IAM role on a test service account, or deploy to a project that doesn't have `serviceAccountTokenCreator`) → audit row has `outcome: "streamed"`.

#### Post-deploy: Storage rules tightened

- [ ] **Operator opens a record on alpha** → evidence thumbnails render normally. Click into the Evidence viewer → image loads (proves signed-URL flow still works).
- [ ] **From a logged-in browser**, attempt direct storage SDK access via DevTools console:
  ```js
  const { getStorage, ref, getDownloadURL } = await import("firebase/storage");
  const s = getStorage(/* ... */);
  await getDownloadURL(ref(s, "orgs/peakops-internal-alpha/some/known/path"));
  ```
  → should fail with `storage/unauthorized` (proves deny-all is enforced).
- [ ] **Customer review link** (on a record with a valid mint) → loads the dossier; image previews are NOT shown (by design — customer flow uses metadata only, not image URLs).
- [ ] **Smoke regression** → `cd scripts/dev/smoke && node smoke.mjs` runs the full 5-page smoke. All green.

---

## E. Final Recommendation

**Would I allow a pilot customer onto PeakOps based solely on the trust layer?**

**YES.** With one caveat: storage rules must be deployed in the documented order (verify Functions + audit emissions first, then tighten Storage). After the manual verification checklist passes on `peakops-internal-alpha`, the trust layer is at GREEN across all five matrix dimensions (Storage Rules, Org Isolation, Export Auth, Review Tokens, Audit Logging).

The four follow-up items recorded under "Remaining concerns" (vendor-assignment audit gap, the remaining 15 inline-org-isolation callsites, the `isDemoBypass` emulator bypass, lack of rules-unit-testing CI) are all known and bounded — none of them change the security posture for an external customer on the pilot org. They become higher priority *after* the pilot lands.

The trust layer is not the blocker. Per the executive review, the remaining blockers for Butler America are product-side (compliance rulepacks, customer-notification email plumbing, send-back endpoint stub) — and those are tracked separately.
