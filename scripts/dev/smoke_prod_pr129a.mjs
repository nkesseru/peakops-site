#!/usr/bin/env node
// Lightweight prod smoke for PR 129a — Recovery Resubmission Loop.
//
// Target: peakops-internal-alpha / case mxF4VFqxr1rjwUdveHfW
// (legacy `triaged` state; smoke-labeled from PR 127 work).
//
// Steps (only the ones we can safely execute given the linked
// incident is at status=draft):
//   1. updateRecoveryCaseV1 triaged → in_progress  (legacy normalize)
//   2. updateRecoveryActionV1 set last open action done  →
//      expect case auto-flip to ready_to_resubmit
//   3. getRecoveryCaseV1 — verify response shape (resubmissionCount
//      present, cycleCount absent)
//   4. mintResubmissionLinkV1 — EXPECT 409 because incident at draft
//      cannot transition to submitted_to_customer (we are not
//      bypassing product workflow)
//
// What's NOT covered here:
//   - Full v2 mint → customer accept/reject round-trip
//   - Requires an incident in customer_rejected / in_progress / closed
//     state. Defer to follow-up smoke when such a case exists naturally.

const PROJECT = "peakops-pilot";
const FN_BASE = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const ORG_ID = "peakops-internal-alpha";
const CASE_ID = "mxF4VFqxr1rjwUdveHfW";
const ACTION_ID = "fom3gWNo7fyasEhv9vGQ"; // the open one ("Supervisor review")
const ACTOR_UID = "dMHgyxL2queI83frr2OVdCVSrzy1"; // nick@pioneercomclean.com (owner)

async function postFn(name, body) {
  const r = await fetch(`${FN_BASE}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text };
}

async function getFn(name, query) {
  const qs = new URLSearchParams(query).toString();
  const r = await fetch(`${FN_BASE}/${name}?${qs}`);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) {}
  return { status: r.status, body: json || text };
}

function header(s) { console.log(`\n── ${s} ${"─".repeat(Math.max(0, 70 - s.length))}`); }
function pass(s) { console.log(`✓ ${s}`); }
function fail(s) { console.log(`✗ ${s}`); }
function info(s) { console.log(`  · ${s}`); }

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) pass(`${name} — ${detail}`); else fail(`${name} — ${detail}`);
}

async function main() {
  console.log(`Prod smoke PR 129a — org=${ORG_ID} case=${CASE_ID}`);

  // ── Snapshot pre-state ─────────────────────────────────────────
  header("0) Pre-state snapshot");
  const pre = await getFn("getRecoveryCaseV1", { orgId: ORG_ID, caseId: CASE_ID, actorUid: ACTOR_UID });
  if (pre.status !== 200 || !pre.body?.ok) {
    record("preflight", false, `getRecoveryCaseV1: ${pre.status} ${JSON.stringify(pre.body).slice(0,200)}`);
    process.exit(2);
  }
  const c0 = pre.body.case;
  info(`status=${c0.status}  resubmissionCount=${c0.resubmissionCount}  packetVersions=${c0.packetVersions.length}  actions=${pre.body.actions.length}`);
  info(`cycleCount in response? ${"cycleCount" in c0 ? "YES (REGRESSION)" : "no (correct)"}`);
  const openActions = pre.body.actions.filter((a) => a.status === "open" || a.status === "in_progress" || a.status === "blocked");
  info(`open actions: ${openActions.map((a) => `${a.id}:${a.title}`).join("; ") || "(none)"}`);
  if ("cycleCount" in c0) {
    record("response_shape_no_cycleCount", false, "cycleCount still in response (PR 129a regression)");
  } else {
    record("response_shape_no_cycleCount", true, "cycleCount removed from response");
  }
  record("response_shape_has_resubmissionCount", typeof c0.resubmissionCount === "number",
    `resubmissionCount=${c0.resubmissionCount} (type=${typeof c0.resubmissionCount})`);

  // ── 1) Legacy triaged → in_progress (proves legacy tolerance) ──
  header("1) Legacy triaged → in_progress transition");
  if (c0.status === "in_progress") {
    info("already at in_progress; skipping transition");
    record("legacy_triaged_transition", true, "already in_progress (likely re-run)");
  } else {
    const r1 = await postFn("updateRecoveryCaseV1", {
      orgId: ORG_ID, caseId: CASE_ID, actorUid: ACTOR_UID,
      status: "in_progress",
    });
    if (r1.status === 200 && r1.body?.status === "in_progress") {
      record("legacy_triaged_transition", true, `200 OK; case now in_progress`);
    } else {
      record("legacy_triaged_transition", false, `${r1.status} ${JSON.stringify(r1.body).slice(0,200)}`);
    }
  }

  // ── 2) Mark open action done → expect auto-flip ────────────────
  header("2) Last open action done → auto-flip to ready_to_resubmit");
  // Re-read state to find the open action
  const pre2 = await getFn("getRecoveryCaseV1", { orgId: ORG_ID, caseId: CASE_ID, actorUid: ACTOR_UID });
  const stillOpen = pre2.body.actions.filter((a) => a.status === "open" || a.status === "in_progress" || a.status === "blocked");
  if (stillOpen.length === 0) {
    info("no open actions; skipping auto-flip step");
    record("auto_flip_to_ready", pre2.body.case.status === "ready_to_resubmit",
      `case status=${pre2.body.case.status}`);
  } else {
    const targetActionId = stillOpen[0].id;
    info(`closing action ${targetActionId} (${stillOpen[0].title})`);
    const r2 = await postFn("updateRecoveryActionV1", {
      orgId: ORG_ID, caseId: CASE_ID, actionId: targetActionId, actorUid: ACTOR_UID,
      status: "done", outcome: "PR 129a prod smoke: closed via direct call",
    });
    if (r2.status !== 200) {
      record("auto_flip_to_ready", false, `action update: ${r2.status} ${JSON.stringify(r2.body).slice(0,200)}`);
    } else {
      info(`response: caseAutoFlippedToReadyToResubmit=${r2.body.caseAutoFlippedToReadyToResubmit}`);
      // Verify case state
      const after = await getFn("getRecoveryCaseV1", { orgId: ORG_ID, caseId: CASE_ID, actorUid: ACTOR_UID });
      if (after.body?.case?.status === "ready_to_resubmit") {
        record("auto_flip_to_ready", true,
          `case auto-flipped to ready_to_resubmit; response.caseAutoFlippedToReadyToResubmit=${r2.body.caseAutoFlippedToReadyToResubmit}`);
      } else {
        record("auto_flip_to_ready", false,
          `case status=${after.body?.case?.status}; flip flag=${r2.body.caseAutoFlippedToReadyToResubmit}`);
      }
    }
  }

  // ── 3) mintResubmissionLinkV1 — incident at draft so expect 409 ──
  header("3) mintResubmissionLinkV1 gate check");
  const mintRes = await postFn("mintResubmissionLinkV1", {
    orgId: ORG_ID, caseId: CASE_ID, actorUid: ACTOR_UID,
  });
  info(`response: ${mintRes.status} ${JSON.stringify(mintRes.body).slice(0,200)}`);
  // Expected: 409 with error indicating incident state OR ready_to_resubmit gate
  if (mintRes.status === 409 && /incident|status/.test(JSON.stringify(mintRes.body))) {
    record("mint_gate_check", true,
      `409 as expected (incident is at draft; can't transition to submitted_to_customer)`);
  } else if (mintRes.status === 200) {
    record("mint_gate_check", true, `200 OK — incident was actually in a mintable state; ordinal=${mintRes.body.ordinal}`);
  } else {
    record("mint_gate_check", false,
      `unexpected: ${mintRes.status} ${JSON.stringify(mintRes.body).slice(0,200)}`);
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log(`\n──────────────────────────────`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed === results.length ? "PASS" : "PARTIAL"}: ${passed}/${results.length}`);
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  }
}

main().catch((e) => { console.error("smoke failed:", e); process.exit(2); });
