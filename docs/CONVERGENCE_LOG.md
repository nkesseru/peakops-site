# PeakOps Convergence Log
Started: 2026-06-11 · Stage 1R-A-prime · Operator: Claude (Desktop Commander) · Approver: Nick

## Tags (pushed to origin)
- prod-source-133b = origin/feat/regac-passive-validation-pr133b (1542fc3)
- pre-converge-main = main (cf802fa)

## Mission P — Production Parity: PROVEN (byte-level)
- Deployed source archives pulled (read-only) from
  gs://gcf-v2-sources-1006996232574-us-central1/ for exportIncidentPacketV1,
  listRecoveryCasesV1, createRecoveryCaseV1, onRecoveryAuditWrite.
- All 4 archives md5-identical (922142f6b11ea12541e5c826eb619862) = one deploy batch.
- Byte-identical vs tag: exportIncidentPacketV1.js, listRecoveryCasesV1.js,
  createRecoveryCaseV1.js, onRecoveryAuditWrite.js, index.js, _authz.js,
  timelineEmit.js, recoveryState.js.
- VERDICT: tag IS production. Gate-9 baseline and rollback target are valid.

## Mission E — Environment Inventory (key NAMES only, no values)
RED FLAG 1 (runtime defect risk, founder decision before convergence DEPLOY):
  functions_clean/env.runtime is git-tracked on BOTH lineages, ships inside prod
  source archives, and _emu_bootstrap.js loads it UNCONDITIONALLY (no
  FUNCTIONS_EMULATOR guard). It sets FIREBASE_STORAGE_EMULATOR_HOST (len 14,
  consistent with 127.0.0.1:9199) in PROD on cold start.
  - exportIncidentPacketV1 already hardened (PEAKOPS_EXPORT_EMU_GATE_V2, 2026-04-24).
  - createEvidenceUploadUrlV1 STILL uses the `!!emuHost ||` disjunct -> prod
    signed-upload path likely detects "emulator". Same pattern:
    uploadEvidenceProxyV1, createEvidenceReadUrlV1, addEvidenceV1.
  - Recommended fix: guard _emu_bootstrap on FUNCTIONS_EMULATOR AND add
    env.runtime + env_quarantine* to .gcloudignore / untrack. Rider on deploy
    stage; not a merge blocker.
RED FLAG 2 (hygiene): env.runtime contains IDENTITY_TOOLKIT_API_KEY (len 39) —
  real key tracked in git + shipped in archives. Added to Mission 0 rotation list.
CLEARED: no .env deploy files exist or are needed; prod runs on code defaults
  (CONTRACT_PACKET_BUCKET -> "peakops-contract-packets"; PEAKOPS_APP_ORIGIN ->
  https://app.peakops.app). OE417/DIRS adapter tokens absent in prod = filings
  adapters inert (deferred scope, acceptable).
NOTE (red-team 1b confirmed): functions_clean has pnpm-lock.yaml only; Cloud
  Build runs unpinned npm install at deploy. Gate 11 uses pnpm frozen-lockfile;
  lockfile strategy = separate post-convergence PR.

## Rollback bundle: BUILT
- ~/peakops-rollback/prod-133b-deployed-source-20260611.zip = exact bytes Cloud
  Build consumed (primary rollback artifact).
- ~/peakops-rollback/src-133b = git worktree @ prod-source-133b; functions_clean
  deps verified installable (pnpm install --frozen-lockfile OK).
- Emulator smoke-boot of bundle deferred to staging rehearsal.

## onUserDeleted provenance: RESOLVED (legacy orphan)
- Deployed 2025-09-16; trigger providers/firebase.auth/eventTypes/user.delete;
  source = UUID zip (console/legacy-era deploy). Source absent from all local
  repos; recoverable from its GCS archive if ever needed.
- Deploy doctrine: explicit --only function lists always, so it is never offered
  for deletion.

## 1R-B GO/NO-GO: GO, with riders
1. RED FLAG 1 decision required before convergence DEPLOY (not before merge).
2. Gate 11 = pnpm frozen-lockfile.
3. env.runtime + quarantine dirs covered by Existence Rule during merge.

## 1R-B — Mechanical class: COMPLETE (2026-06-11)
- Branch: integrate/recovery-backend-133b; merge --no-ff --no-commit from
  origin/feat/regac-passive-validation-pr133b re-run; merge left OPEN by design for 1R-C/D/E.
- Resolved 31/31 DU conflicts as deletions (git rm), all within approved families:
  admin/_components x17 (incl. TimelinePreviewMock.tsx~), admin/contracts x4,
  admin/incidents legacy panels x5, admin/queue x1, admin/stormwatch x4.
- Existence Rule honored: env.runtime, env_quarantine*, dist/, .bak files untouched.
- exportIncidentPacketV1.js NOT touched (remains UU for 1R-D).
- Remaining unresolved: 35 = 8 backend code files (7 UU + listOrgMembersV1 AA)
  + functions_clean/pnpm-lock.yaml + 23 frontend files (UU/AA, incl. package.json)
  + next-app/pnpm-lock.yaml. Matches trial-merge prediction exactly (33 real + 2 locks).
- Checkpoint B: PASS. No deploy, no push.

## 1R-C — Backend judgment files: COMPLETE (2026-06-11)
Resolved (hunk-level, deterministic resolver, node --check clean on all):
- index.js: hunk1=THEIRS (superset: templates trio + bootstrapPilotOrgV1 + listOrgMembersV1);
  hunk2=BOTH (main's teamRecoveryV1 preserved + branch customer-review trio + full recovery set).
  EXPORT UNION VERIFIED: merged=70 = main(39) UNION branch(69); zero missing from either side.
- addEvidenceV1.js: THEIRS x5 — restores prod authz gate, requirementSlotFields (PR 94a),
  readiness cache refresh (PR 108); uploaderUid sourced from authz actorUid (main's standalone
  extractActorUid fallback subsumed). NOTE: main's top-level derivePlatform (L26) retained via
  auto-merge; branch's inline const shadows it in-scope — harmless; post-convergence cleanup item.
- createEvidenceUploadUrlV1.js: THEIRS x3 — security-critical signed-URL authz gate
  (PEAKOPS_AUTHZ_ROLE_RETROFIT_V1) restored; hunk3 variable-rename consistency.
  RED FLAG 1 emulator predicate deliberately NOT touched (own later review).
- uploadEvidenceProxyV1.js: THEIRS x1 (authz imports).
- saveIncidentNotesV1.js: THEIRS, OURS, THEIRS — hunk2 kept MAIN's comment block documenting
  the canonical top-level notes path fix. *** ONLY main-over-branch decision in 1R-C;
  comment-only, zero logic. *** Hunk3 theirs adds notesStatus/notesBypassReason checkpoint
  (superset of main's write).
- approveAndLockJobV1.js: THEIRS x1 — contains main's sealed-record check verbatim PLUS
  incident-existence/org-mismatch fix (PEAKOPS_RESOURCE_INTEGRITY_V1). Nothing of main's lost.
- listOrgMembersV1.js (AA): THEIRS — newer _authz/_actor pattern, consistent with prod;
  main's jobAuthz variant equivalent-but-older, discarded.
- functions_clean/pnpm-lock.yaml: THEIRS per prod-lockfile rule; verified covers all 7 deps
  of the auto-merged package.json.
Auth note for 1R-C2: two auth-helper families now coexist (jobAuthz.js — recovery fns,
listJobsV1; _authz.js — evidence/org fns). No contradiction found; C2 must confirm they compose.
Checkpoint C: PASS. exportIncidentPacketV1.js untouched (sole UU in functions_clean).
No deploy, no push.

## 1R-C2 — Auto-Merged File Audit: COMPLETE (2026-06-11) — read-only
Merge-base 8dd8d40 (2026-03-20). Method: 3-way numstat + byte-equality + line-containment checks.
VERDICTS (8/8 COMPOSES):
- _authz.js: COMPOSES — byte-IDENTICAL twin-add on both lineages (same code landed on both).
- _actor.js, createAddendumV1.js, createAddendumUploadUrlV1.js, listAddendaV1.js: COMPOSES —
  byte-identical twin-adds, same as above.
- timelineEmit.js: COMPOSES — main's 8+/1- (actorUid field, PR 40A) verbatim-contained in
  branch's 23+/7-; branch additionally routes emits through resolveIncidentRef so emitter and
  getTimelineEventsV1 reader use the same canonical org-scoped path (drift fix). Nothing lost.
- addMaterialV1.js, approveJobV1.js: COMPOSES — every main-added line verbatim-present in
  branch's superset; merged == branch == prod.
AUTH-FAMILY QUESTION RESOLVED (corrects 1R-C note): there is only ONE active auth family —
_authz.js/_actor.js. Recovery fns AND listJobsV1 use _authz/_actor (verified by require scan).
jobAuthz.js is DELETED on both lineages; its sole remaining consumer is teamRecoveryV1.js.
NEEDS-EDIT (1, pre-existing on main, NOT merge-caused):
- teamRecoveryV1.js requires "./jobAuthz" (deleted on main in the "MVP GOLDEN PATH" cleanup,
  7f4e377). safeExport try/catch has silently skipped teamRecoveryV1 at load ever since →
  Rapid Access Recovery (PR 49) has been dead on main. Merge union now exports it; convergence
  deploy would ship a load-skipped function (harmless but dead). RIDER FIX post-merge: port
  teamRecoveryV1 auth to _authz/_actor (recommended) or restore jobAuthz.js. Own reviewed change.
FOUNDER-DECISION items: none from these 8 files.
Event-type renderability: low-risk cosmetic; full emitter-vs-renderer diff remains gate 14.
Checkpoint C2: PASS. No files edited. No deploy, no push.

## 1R-D — Dangerous file: COMPLETE (2026-06-12) — Founder Review #1 PASSED
- exportIncidentPacketV1.js resolved (by Claude Code prior 1R-D run, per founder; verified here).
- Verification: working vs prod(:3) = 0 lines removed, exactly 35 added = _entitlement import
  + PEAKOPS_ENTITLEMENT_GATE_V1 block verbatim (requireEntitlement riskDefenseModule, 402 +
  featureKey, deny/ok logging), placed post-validation pre-reads. Branch markers intact
  (EMU_GATE_V2, PR 98/99). Main's PR 46 hash machinery confirmed present in branch lineage —
  nothing lost. node --check clean (3,425 lines). STAGED.
- Founder approved in-chat; authorship: Claude Code 1R-D session.

## 1R-E — Frontend + merge commit: COMPLETE (2026-06-12)
- Flagged diff-review PASSED: IncidentClient/SummaryClient branch-side additions are stale
  precursors of readiness/NextBestAction consolidation main already has (13 and 61 refs
  respectively on main side; SummaryClient branch delta had zero such refs). Nothing lost.
- All 24 frontend UU/AA files resolved --ours (main): frontend stays byte-identical to the
  deployed Vercel lineage. AA auth-layer files all divergent-twins; main's newer set kept.
- next-app/package.json: single hunk next 16.2.6(main) vs 16.0.11(branch) -> MAIN per
  version-conflict rule; remainder auto-merged. Valid JSON verified.
- next-app/pnpm-lock.yaml: ours + pnpm install --lockfile-only regen (no drift; 260ms no-op
  = lockfile already satisfies merged manifest).
- Marker sweep repo-wide: CLEAN. Unresolved: 0.

## Checkpoint E — merge commit + delta audit: PASS (2026-06-12)
- Merge commit 5e32fb5 on integrate/recovery-backend-133b; tagged converge-rc1.
- Backend delta vs prod-source-133b = 8 files, ALL attributable:
  _billing.js + _entitlement.js (spine, main-only) · exportIncidentPacketV1.js (the 35-line
  gate) · index.js (70-export union) · saveIncidentNotesV1.js (main comment block, hunk-2
  ours) · teamRecoveryV1.js (main-only; known dead-require rider) · addEvidenceV1.js
  (+13/-0: main's top-level derivePlatform, pure addition, shadowed in handler scope —
  known cosmetic item) · env.runtime (+1 key name IDENTITY_TOOLKIT_API_KEY vs prod copy;
  inert, file slated for deploy-exclusion under Red Flag 1 fix).
- No unattributable deltas. Frontend = main verbatim. No push, no deploy.
NEXT: 1R-F gauntlet (gates 1-16; gate 11 clean-install first), then founder review #2 (PR).

## Class 1B — Orphan consumer cleanup (2026-06-12, founder-approved)
- Deleted next-app/app/admin/incidents/[id]/page.tsx: sole consumer of five _components
  modules removed in Class 1 (TimelinePreviewMock, BackendBadge, AdminNav,
  GuidedWorkflowPanel, ValidationPanel). Same dead admin incident suite; main retained the
  page but Class 1 deletions orphaned it; Gate 1 (tsc) exposed it.
