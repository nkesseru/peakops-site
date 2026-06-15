#!/usr/bin/env node
// End-to-end verification of the Recovery loop (PR 127a–133B) on
// peakops-internal-alpha / peakops-pilot.
//
// Two fresh alpha incidents:
//   A) Standalone createRecoveryCaseV1 — verifies manual create
//      with explicit revenueAtRisk + cause + ownership.
//   B) Full loop: setup → packet → mint review → customer REJECT
//      (auto-creates recovery case) → addRecoveryActionV1 →
//      completeRecoveryFieldWorkV1 (auto-flips to
//      ready_to_resubmit) → mintResubmissionLinkV1 → customer
//      ACCEPT → autoResolveOnAccept → recovered.
//
// Reports IDs + status-before/after at each step. Stops at first
// non-2xx with the exact failing body.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const sha256 = (s) => createHash("sha256").update(String(s||""), "utf8").digest("hex");
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const PROJECT = "peakops-pilot";
const FN_BASE = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const ORG = "peakops-internal-alpha";
const OWNER_UID = "dMHgyxL2queI83frr2OVdCVSrzy1";   // role=owner
const ADMIN_UID = "qTZahBZ59UTHj0CGNSdjF8ivyhX2";   // role=admin
const CUSTOMER_EMAIL = "nick+e2e@pioneercomclean.com";

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

function ok(s)  { return `\x1b[32m${s}\x1b[0m`; }
function bad(s) { return `\x1b[31m${s}\x1b[0m`; }
function yel(s) { return `\x1b[33m${s}\x1b[0m`; }
function head(label, title) { console.log(`\n══ ${label}. ${title} ${"═".repeat(Math.max(0, 60-title.length))}`); }
function sub(n, title)      { console.log(`  ── ${n}. ${title}`); }

async function post(fn, body) {
  const r = await fetch(`${FN_BASE}/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text, raw: text };
}
async function get(fn, qs) {
  const url = `${FN_BASE}/${fn}?${new URLSearchParams(qs).toString()}`;
  const r = await fetch(url);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text, raw: text };
}
function require200(label, res) {
  if (res.status < 200 || res.status >= 300 || (res.body && res.body.ok === false)) {
    console.log(bad(`✗ FAIL at ${label} — status=${res.status}`));
    console.log("  body:", typeof res.body === "string" ? res.body.slice(0, 600) : JSON.stringify(res.body).slice(0, 800));
    process.exit(1);
  }
}

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

async function readIncident(id) {
  const c = await db.doc(`orgs/${ORG}/incidents/${id}`).get();
  if (c.exists) return c.data();
  const l = await db.doc(`incidents/${id}`).get();
  return l.exists ? l.data() : null;
}
async function readCase(caseId) {
  const c = await db.doc(`orgs/${ORG}/recovery_cases/${caseId}`).get();
  return c.exists ? { id: c.id, ...c.data() } : null;
}
async function findActiveCaseForIncident(incidentId) {
  const q = await db.collection(`orgs/${ORG}/recovery_cases`)
    .where("incidentId", "==", incidentId)
    .limit(5).get();
  return q.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── Reusable setup: drive a fresh incident through to packet v1 ──
async function setupIncidentToPacket(label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const incidentId = `e2e_rec_${label}_${stamp}_${Math.random().toString(36).slice(2,6)}`;

  sub("1", `createIncidentV1 (${incidentId})`);
  let r = await post("createIncidentV1", {
    orgId: ORG, actorUid: OWNER_UID, incidentId,
    title: `E2E recovery — ${label}`,
    status: "open",
    archetype: "fiber",
    filingTypesRequired: ["DIRS"],
    location: "Internal Alpha Test — Seattle",
    customer: "Internal Alpha",
    priority: "normal",
  });
  require200("createIncidentV1", r);

  sub("2", "createJobV1");
  r = await post("createJobV1", {
    orgId: ORG, incidentId, actorUid: OWNER_UID,
    title: "Recovery E2E setup task",
  });
  require200("createJobV1", r);
  const jobId = r.body.job?.jobId || r.body.jobId;

  sub("3", "startFieldSession + markArrived");
  r = await post("startFieldSessionV1", {
    orgId: ORG, incidentId, actorUid: OWNER_UID, techUserId: OWNER_UID,
  });
  require200("startFieldSessionV1", r);
  const sessionId = r.body.sessionId;
  r = await post("markArrivedV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    gps: { lat: 47.6062, lng: -122.3321, accuracyM: 8 },
  });
  require200("markArrivedV1", r);

  sub("4", "evidence upload + addEvidence");
  r = await post("createEvidenceUploadUrlV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID,
    fileName: "e2e_recovery.png", contentType: "image/png",
  });
  require200("createEvidenceUploadUrlV1", r);
  const { uploadUrl, uploadMethod, storagePath, bucket } = r.body;
  const putRes = await fetch(uploadUrl, {
    method: uploadMethod,
    headers: { "content-type": "image/png" },
    body: PNG_1x1,
  });
  if (!putRes.ok) { console.log(bad(`GCS PUT failed: ${putRes.status}`)); process.exit(1); }
  const sha = createHash("sha256").update(PNG_1x1).digest("hex");
  r = await post("addEvidenceV1", {
    orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID, jobId,
    bucket, storagePath,
    fileName: "e2e_recovery.png", originalName: "e2e_recovery.png",
    contentType: "image/png", sizeBytes: PNG_1x1.length, sha256: sha,
    phase: "DAMAGE", labels: ["DAMAGE"],
    gps: { lat: 47.6062, lng: -122.3321, accuracyM: 8 },
  });
  require200("addEvidenceV1", r);

  sub("5", "markJobComplete + submitField + review + approve + close");
  r = await post("markJobCompleteV1", { orgId: ORG, incidentId, jobId, actorUid: OWNER_UID, sessionId });
  require200("markJobCompleteV1", r);
  r = await post("submitFieldSessionV1", { orgId: ORG, incidentId, sessionId, actorUid: OWNER_UID });
  require200("submitFieldSessionV1", r);
  r = await post("updateJobStatusV1", { orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID, status: "review" });
  require200("updateJobStatusV1(review)", r);
  r = await post("approveJobV1", { orgId: ORG, incidentId, jobId, actorUid: ADMIN_UID });
  require200("approveJobV1", r);
  r = await post("closeIncidentV1", { orgId: ORG, incidentId, actorUid: ADMIN_UID });
  require200("closeIncidentV1", r);

  sub("6", "exportIncidentPacketV1");
  r = await post("exportIncidentPacketV1", { orgId: ORG, incidentId, actorUid: ADMIN_UID });
  require200("exportIncidentPacketV1", r);
  const inc = await readIncident(incidentId);
  const packetV = inc.packetMeta?.packetVersion;
  console.log(`     ✓ packet v${packetV}`);

  return { incidentId, jobId, sessionId, packetV };
}

// ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`E2E recovery loop — ${PROJECT}/${ORG}\n`);

  // ════════════════════════════════════════════════════════════════
  // INCIDENT A — Standalone createRecoveryCaseV1 verification.
  // ════════════════════════════════════════════════════════════════
  head("A", "createRecoveryCaseV1 standalone");
  const A = await setupIncidentToPacket("manual");

  sub("7", "createRecoveryCaseV1 (manual, explicit revenueAtRisk)");
  let r = await post("createRecoveryCaseV1", {
    orgId: ORG, incidentId: A.incidentId, actorUid: ADMIN_UID,
    source: "internal_qc",
    cause: {
      primary: "missing_required_proof",
      operatorNotes: "E2E manual create — exercising createRecoveryCaseV1 with explicit payload.",
    },
    revenueAtRisk: { amount: 4200, type: "estimated", notes: "Estimated reroute + truck roll" },
    ownerRole: "coordinator",
  });
  require200("createRecoveryCaseV1", r);
  const manualCaseId = r.body.caseId;
  const manualCase = await readCase(manualCaseId);
  console.log(`     ✓ caseId=${manualCaseId}`);
  console.log(`       status:        ${manualCase.status}              expected=open`);
  console.log(`       revenueAtRisk: ${JSON.stringify({ amount: manualCase.revenueAtRisk?.amount, type: manualCase.revenueAtRisk?.type, currency: manualCase.revenueAtRisk?.currency })}`);
  console.log(`       source:        ${manualCase.rejection?.source}`);
  console.log(`       ownership:     owner=${manualCase.ownership?.owner} role=${manualCase.ownership?.ownerRole}`);
  console.log(`       cause:         primary=${manualCase.cause?.primary}`);
  const A_ok =
    manualCase.status === "open" &&
    manualCase.revenueAtRisk?.amount === 4200 &&
    manualCase.revenueAtRisk?.type === "estimated" &&
    manualCase.rejection?.source === "internal_qc";
  console.log(A_ok ? ok("     ✅ standalone case verified") : bad("     ✗ standalone case mismatch"));

  // ════════════════════════════════════════════════════════════════
  // INCIDENT B — Full loop via customer reject → auto-create.
  // ════════════════════════════════════════════════════════════════
  head("B", "Full recovery loop (customer reject → recovered)");
  const B = await setupIncidentToPacket("loop");

  sub("7", "createCustomerReviewLinkV1 (initial customer review)");
  r = await post("createCustomerReviewLinkV1", {
    orgId: ORG, incidentId: B.incidentId, actorUid: ADMIN_UID,
    customerEmail: CUSTOMER_EMAIL,
  });
  require200("createCustomerReviewLinkV1", r);
  const tokenA = r.body.token;
  const tokenAHash = sha256(tokenA);
  const linkA = (await db.doc(`customer_review_links/${tokenAHash}`).get()).data() || {};
  console.log(`     ✓ initial token (slice-1-pinned)  pinnedPacket.v=${linkA.pinnedPacket?.version}`);

  sub("8", "submitCustomerReviewV1 action=REJECT (triggers auto-create)");
  const incBeforeReject = await readIncident(B.incidentId);
  r = await post("submitCustomerReviewV1", {
    token: tokenA, action: "reject",
    comment: "E2E rejection — missing OTDR trace screenshots from segment 3. Please reattach and resend.",
  });
  require200("submitCustomerReviewV1(reject)", r);
  const incAfterReject = await readIncident(B.incidentId);
  console.log(`     incident.status:  ${incBeforeReject.status} → ${incAfterReject.status}`);

  // Wait a beat for the auto-create + audit writes to settle, then read the case.
  await new Promise(res => setTimeout(res, 1500));
  const autoCases = await findActiveCaseForIncident(B.incidentId);
  if (!autoCases.length) {
    console.log(bad("✗ no recovery case auto-created after reject")); process.exit(1);
  }
  const autoCase = autoCases[0];
  console.log(`     ✓ auto-created caseId=${autoCase.id}`);
  console.log(`       status:        ${autoCase.status}`);
  console.log(`       source:        ${autoCase.rejection?.source}`);
  console.log(`       cause.customerComment: ${autoCase.cause?.customerComment ? `"${String(autoCase.cause.customerComment).slice(0,60)}…"` : "<none>"}`);
  console.log(`       cause.primary: ${autoCase.cause?.primary || "<not inferred>"}`);

  sub("9", "addRecoveryActionV1 (operator adds remediation)");
  r = await post("addRecoveryActionV1", {
    orgId: ORG, actorUid: ADMIN_UID,
    caseId: autoCase.id,
    type: "provide_test_results",
    title: "Reattach OTDR traces for segment 3",
    description: "Customer flagged missing test results — capture from kit and reupload.",
    assignee: ADMIN_UID,           // direct UID match satisfies isVisibleToActor
    assigneeRole: "field_lead",
  });
  require200("addRecoveryActionV1", r);
  const actionId = r.body.actionId || r.body.action?.actionId || r.body.action?.id;
  const actionDoc = (await db.doc(`orgs/${ORG}/recovery_cases/${autoCase.id}/actions/${actionId}`).get()).data() || {};
  console.log(`     ✓ actionId=${actionId}`);
  console.log(`       type=${actionDoc.type}  status=${actionDoc.status}  assignee=${actionDoc.assignee?.slice(0,8)}…`);
  // Should bump case from open → in_progress (per addRecoveryAction semantics)
  const caseAfterAdd = await readCase(autoCase.id);
  console.log(`     case.status after add: ${caseAfterAdd.status}`);

  sub("10", "completeRecoveryFieldWorkV1 (close every open action → auto-flip)");
  // The auto-create seeds a "clarify_with_customer" starter action that
  // the operator must triage before the case can flip. Discover + close
  // every open action, not just the one we added.
  const allActions = await db.collection(`orgs/${ORG}/recovery_cases/${autoCase.id}/actions`).get();
  console.log(`     actions on case: ${allActions.size}`);
  for (const adoc of allActions.docs) {
    const a = adoc.data() || {};
    if (a.status === "done" || a.status === "skipped") continue;
    console.log(`       → completing ${adoc.id}  type=${a.type}  was=${a.status}`);
    const rr = await post("completeRecoveryFieldWorkV1", {
      orgId: ORG, incidentId: B.incidentId, actionId: adoc.id, actorUid: ADMIN_UID,
      status: "done",
      outcome: a.type === "provide_test_results"
        ? "OTDR traces reattached; segment 3 loss budget within spec."
        : "Reviewed customer feedback; next steps captured in actions.",
    });
    require200(`completeRecoveryFieldWorkV1(${adoc.id})`, rr);
  }
  await new Promise(res => setTimeout(res, 1500));   // let auto-flip settle
  const caseAfterComplete = await readCase(autoCase.id);
  console.log(`     case.status after all-done: ${caseAfterComplete.status}`);
  if (caseAfterComplete.status !== "ready_to_resubmit") {
    console.log(bad(`     ✗ expected ready_to_resubmit, got ${caseAfterComplete.status}`));
  }

  sub("11", "exportIncidentPacketV1 v2 (regenerate after fix)");
  r = await post("exportIncidentPacketV1", { orgId: ORG, incidentId: B.incidentId, actorUid: ADMIN_UID });
  require200("exportIncidentPacketV1(v2)", r);
  const incBeforeMint = await readIncident(B.incidentId);
  const packetV2 = incBeforeMint.packetMeta?.packetVersion;
  console.log(`     ✓ regenerated packet v${packetV2}  (was v${B.packetV})`);

  sub("12", "mintResubmissionLinkV1 (case ready_to_resubmit → awaiting_customer)");
  r = await post("mintResubmissionLinkV1", {
    orgId: ORG, actorUid: ADMIN_UID,
    caseId: autoCase.id,
    changeSummary: "Reattached OTDR traces for segment 3 per your feedback.",
  });
  require200("mintResubmissionLinkV1", r);
  const tokenR = r.body.token;
  const tokenRHash = sha256(tokenR);
  const tokenRHashPrefix = r.body.tokenHashPrefix;
  console.log(`     ✓ resubmission token=${tokenR.slice(0,16)}…  packetOrdinal=${r.body.ordinal}`);
  console.log(`     case.status: ${r.body.status}  url=${r.body.url}`);

  const linkR = (await db.doc(`customer_review_links/${tokenRHash}`).get()).data() || {};
  const incAfterMint = await readIncident(B.incidentId);
  console.log(`     link.sourceStatus = ${linkR.sourceStatus}`);
  console.log(`     link.pinnedPacket = ${linkR.pinnedPacket ? JSON.stringify({v: linkR.pinnedPacket.version}) : yel("ABSENT (mintResubmissionLinkV1 does not apply slice 1 pin)")}`);
  console.log(`     incident.status: ${incAfterMint.status}  (was ${incBeforeMint.status})`);

  sub("13", "getCustomerReviewV1 (verify customer can read resubmission)");
  r = await get("getCustomerReviewV1", { token: tokenR });
  require200("getCustomerReviewV1(resub)", r);
  const rv = r.body;
  console.log(`     packet.pinned   = ${rv.packet?.pinned ? `v${rv.packet.pinned.version}` : yel("null (no slice-1 pin)")}`);
  console.log(`     packet.current  = ${rv.packet?.current ? `v${rv.packet.current.version}` : "<none>"}`);
  console.log(`     packet.isLatest = ${rv.packet?.isLatest}`);
  console.log(`     review payload:  status=${rv.status}  consumed=${rv.consumed}  packet?=${!!rv.packet}  review?=${!!rv.review}`);

  sub("14", "submitCustomerReviewV1 action=ACCEPT (resubmission)");
  r = await post("submitCustomerReviewV1", {
    token: tokenR, action: "accept",
    comment: "E2E acceptance of resubmission — OTDR traces verified.",
  });
  require200("submitCustomerReviewV1(accept-resub)", r);

  await new Promise(res => setTimeout(res, 1500));   // let autoResolveOnAccept settle
  const caseFinal = await readCase(autoCase.id);
  const incFinal = await readIncident(B.incidentId);
  console.log(`     case.status:     ${caseFinal.status}`);
  console.log(`     case.resolution: ${JSON.stringify(caseFinal.resolution || null)}`);
  console.log(`     case.resolvedAt: ${caseFinal.resolvedAt?.toDate?.()?.toISOString?.() || "<absent>"}`);
  console.log(`     incident.status: ${incFinal.status}  customerAcceptedPacketVersion=${incFinal.customerAcceptedPacketVersion}`);

  // ════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════
  head("S", "Summary");

  const checks = {
    "A.1 createRecoveryCaseV1 — case created":         !!manualCase,
    "A.2 createRecoveryCaseV1 — revenueAtRisk populated": manualCase.revenueAtRisk?.amount === 4200 && manualCase.revenueAtRisk?.type === "estimated",
    "A.3 createRecoveryCaseV1 — status=open":          manualCase.status === "open",

    "B.1 customer reject → auto-create case":          !!autoCase,
    "B.2 addRecoveryActionV1 — action appears":        actionDoc && actionDoc.type === "provide_test_results" && actionDoc.status === "open",
    "B.3 completeRecoveryFieldWorkV1 — auto-flip":     caseAfterComplete.status === "ready_to_resubmit",
    "B.4 mintResubmissionLinkV1 — review token created": !!tokenR,
    "B.5 mintResubmissionLinkV1 — pinned packet exists": !!linkR.pinnedPacket,
    "B.6 customer review page opens":                  !!rv.review && rv.ok === true,
    "B.7 customer accept → case=recovered":            caseFinal.status === "recovered",
    "B.8 incident → customer_accepted":                incFinal.status === "customer_accepted",
  };

  let passed = 0, failed = 0;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? ok("✓") : bad("✗")} ${k}`);
    if (v) passed++; else failed++;
  }

  const total = passed + failed;
  console.log(`\n  result: ${passed}/${total} checks passed`);

  let verdict;
  if (failed === 0) verdict = ok("🟢 GREEN — full recovery loop proven");
  else if (passed >= total * 0.7 && caseFinal.status === "recovered") verdict = yel(`🟡 YELLOW — recovery loop completes but ${failed} secondary check(s) failed`);
  else verdict = bad("🔴 RED — broken transition in the recovery loop");

  console.log(`\n  ${verdict}\n`);
  console.log(`  Summary URLs:`);
  console.log(`    Incident A (manual case):  https://app.peakops.app/incidents/${A.incidentId}/summary?orgId=${ORG}`);
  console.log(`    Manual recovery case:      https://app.peakops.app/recovery/${manualCaseId}?orgId=${ORG}`);
  console.log(`    Incident B (looped):       https://app.peakops.app/incidents/${B.incidentId}/summary?orgId=${ORG}`);
  console.log(`    Looped recovery case:      https://app.peakops.app/recovery/${autoCase.id}?orgId=${ORG}`);
  console.log(`    Initial review (consumed): https://app.peakops.app/review/${tokenA}`);
  console.log(`    Resubmission (consumed):   https://app.peakops.app/review/${tokenR}`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(bad("unexpected error:"), e?.stack || e);
  process.exit(2);
});
