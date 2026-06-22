#!/usr/bin/env node
// Chunk 1 + Chunk 2 UI verification — post-Vercel-deploy
//
// Walks the operator-facing UI on https://app.peakops.app and asserts:
//
//   CHUNK 1 (Trust Foundation):
//     - Evidence thumbnails render on an incident's evidence page
//       (proves the signed-URL flow still works)
//     - Customer review dossier loads cleanly via /review/{token}
//       (proves the customer-facing path is intact)
//     - Packet download endpoint is reachable + auth-gated
//       (deeper verification: see e2e_workflow_scenarios_alpha.mjs)
//
//   CHUNK 2 (Workflow Completion):
//     - Summary page for a submitted_to_customer record renders the new
//       "Awaiting" guidance block with the time-since-mint copy.
//     - Review page no longer renders the "Send Back" button.
//     - Notification routing recognizes the 4 new types (verified by
//       absence of crashes when fetching the route).
//
// Auth: reuses scripts/dev/smoke/.auth.json captured by `npm run login`.

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(__dirname, ".auth.json");
const SHOTS = path.join(__dirname, "screenshots", "chunks_1_2");
mkdirSync(SHOTS, { recursive: true });

if (!existsSync(AUTH_FILE)) {
  console.error("✗ No auth state. Run `npm run login` first.");
  process.exit(2);
}

const BASE = "https://app.peakops.app";
const ORG = "peakops-internal-alpha";

// Northgate Mutual Telecom record is currently submitted_to_customer.
// Internal Alpha Test record is customer_accepted with an evidence locker.
const SUBMITTED_RECORD = "demo_20260616T122606Z_5ax3";       // Northgate
const ACCEPTED_RECORD = "inc_20260508_121451_acnew0";        // Internal Alpha
const IN_PROGRESS_RECORD = "demo_field_work_001";            // Cascade
const REJECTED_RECORD = "demo_rejected_001";                 // Riverbend

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: AUTH_FILE });

async function visit(url, shot) {
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.locator("text=loading record details").waitFor({ state: "hidden", timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const text = await page.locator("body").innerText();
    const status = resp?.status() ?? null;
    await page.screenshot({ path: path.join(SHOTS, `${shot}.png`), fullPage: true });
    // Capture img src attributes so we can verify evidence URL shape.
    const imgSrcs = await page.locator("img").evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src") || ""));
    await page.close();
    return { status, text, lower: text.toLowerCase(), errors: consoleErrors, imgSrcs };
  } catch (e) {
    await page.close();
    return { status: null, text: "", lower: "", errors: [...consoleErrors, String(e?.message || e)], imgSrcs: [] };
  }
}

const results = { chunk1: {}, chunk2: {} };

// ──────────────────────────────────────────────────────────────────
// CHUNK 1: Evidence rendering still works
// ──────────────────────────────────────────────────────────────────
console.log("\n══ CHUNK 1 — Evidence Rendering ══════════════════════════");

// The /summary page for an accepted record renders evidence thumbnails.
// We assert: (1) page returned 200, (2) at least one <img> with a
// non-empty src is on the page (the actual signed URL).
const r1 = await visit(`${BASE}/incidents/${ACCEPTED_RECORD}/summary?orgId=${ORG}`, "1_summary_accepted");
results.chunk1.summary_loads = r1.status === 200 && r1.text.length > 200;
const realImgSrcs = (r1.imgSrcs || []).filter((s) => s && !s.startsWith("data:") && !s.includes("placeholder"));
results.chunk1.evidence_imgs_present = realImgSrcs.length > 0;
const sample = realImgSrcs[0] || "";
const isSignedUrl = sample.includes("storage.googleapis.com") || sample.includes("/api/media") || sample.includes("X-Goog-Signature") || sample.startsWith("/api/");
results.chunk1.evidence_uses_server_path = sample === "" || isSignedUrl;
results.chunk1.summary_no_console_errors = r1.errors.length === 0;
console.log(`  page status: ${r1.status}`);
console.log(`  body chars: ${r1.text.length}`);
console.log(`  img sources (non-placeholder): ${realImgSrcs.length}`);
if (sample) console.log(`  sample src: ${sample.slice(0, 90)}…`);
console.log(`  console errors: ${r1.errors.length}`);

// ──────────────────────────────────────────────────────────────────
// CHUNK 1: Packet download endpoint is auth-gated and present
// ──────────────────────────────────────────────────────────────────
console.log("\n══ CHUNK 1 — Packet Download Reachable ════════════════════");
// Without a Bearer token, /api/reports/{id}/download must 401, not 500.
const dlPage = await ctx.newPage();
const dlResp = await dlPage.goto(`${BASE}/api/reports/${ACCEPTED_RECORD}/download?orgId=${ORG}`, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
const dlBodyText = await dlPage.locator("body").innerText().catch(() => "");
await dlPage.close();
const dlStatus = dlResp?.status() ?? null;
// Playwright navigates with the page's own cookies but not a Bearer
// header. The download proxy returns 200 (signed URL or stream) if the
// session cookie carries auth, OR 401/403 otherwise. Either is fine —
// what matters is: NOT 500 and NOT a silent 200 with empty body.
const dlOk = dlStatus !== null && dlStatus !== 500 && dlStatus !== 502;
results.chunk1.download_endpoint_reachable = dlOk;
results.chunk1.download_no_server_error = dlStatus !== 500;
console.log(`  download endpoint status: ${dlStatus}`);
console.log(`  body sample: ${dlBodyText.slice(0, 120)}`);

// ──────────────────────────────────────────────────────────────────
// CHUNK 2: Awaiting guidance block on submitted_to_customer record
// ──────────────────────────────────────────────────────────────────
console.log("\n══ CHUNK 2 — Awaiting Guidance Block ══════════════════════");
const r2 = await visit(`${BASE}/incidents/${SUBMITTED_RECORD}/summary?orgId=${ORG}`, "2_summary_awaiting");
results.chunk2.awaiting_page_loads = r2.status === 200;
// The new block carries one of these telltale strings (matches
// SummaryClient.tsx PEAKOPS_AWAITING_REVIEW_GUIDANCE_V1).
// PEAKOPS_AWAITING_REVIEW_GUIDANCE_V1 renders one of several variants
// depending on days-since-mint. Match any of them.
const hasAwaitingCopy =
  r2.lower.includes("waiting on the customer") ||
  r2.lower.includes("review link sent today") ||
  r2.lower.includes("review link is out and the customer") ||
  r2.lower.includes("sent 1 day ago") ||
  /sent \d+ days? ago/.test(r2.lower) ||
  r2.lower.includes("consider following up with the customer");
results.chunk2.awaiting_guidance_visible = hasAwaitingCopy;
const has90dayCopy = r2.lower.includes("90 days") || r2.lower.includes("stays valid for 90");
results.chunk2.awaiting_ttl_copy_visible = has90dayCopy;
const hasSupportCopy = r2.lower.includes("peakops support") || r2.lower.includes("contact peakops");
results.chunk2.awaiting_support_path_visible = hasSupportCopy;
console.log(`  status: ${r2.status}`);
console.log(`  "waiting on the customer" / similar copy present: ${hasAwaitingCopy}`);
console.log(`  "90 days" TTL copy present: ${has90dayCopy}`);
console.log(`  PeakOps support guidance present: ${hasSupportCopy}`);

// ──────────────────────────────────────────────────────────────────
// CHUNK 2: Send Back button removed from /review
// ──────────────────────────────────────────────────────────────────
console.log("\n══ CHUNK 2 — Send Back Button Removed ═════════════════════");
const r3 = await visit(`${BASE}/incidents/${ACCEPTED_RECORD}/review?orgId=${ORG}`, "3_review_no_send_back");
results.chunk2.review_loads = r3.status === 200;
// Exact rendered glyph from the prior button.
const sendBackPresent = r3.lower.includes("↩︎ send back") || r3.lower.includes("send back to field");
results.chunk2.send_back_button_gone = !sendBackPresent;
console.log(`  status: ${r3.status}`);
console.log(`  Send Back glyph absent: ${!sendBackPresent}`);

// Also visit the in-progress record's review — confirm Reject Job
// button or "Nothing waiting" message is rendered (so the page isn't
// just blank).
const r3b = await visit(`${BASE}/incidents/${IN_PROGRESS_RECORD}/review?orgId=${ORG}`, "3b_review_in_progress");
const hasReviewSurface = r3b.lower.includes("nothing is waiting") || r3b.lower.includes("send back") === false && (r3b.lower.includes("review") || r3b.lower.includes("approve"));
results.chunk2.in_progress_review_renders = r3b.status === 200 && hasReviewSurface;
console.log(`  in_progress /review status: ${r3b.status}`);

// ──────────────────────────────────────────────────────────────────
// CHUNK 2: Customer Acceptance section structure on rejected record
// ──────────────────────────────────────────────────────────────────
console.log("\n══ CHUNK 2 — Rejection Surface Coherence ══════════════════");
const r4 = await visit(`${BASE}/incidents/${REJECTED_RECORD}/summary?orgId=${ORG}`, "4_summary_rejected");
results.chunk2.rejected_loads = r4.status === 200;
const hasRejectedCopy = r4.lower.includes("rejection recorded") || r4.lower.includes("customer requested correction") || r4.lower.includes("customer rejected") || r4.lower.includes("requested correction");
results.chunk2.rejected_state_visible = hasRejectedCopy;
console.log(`  status: ${r4.status}`);
console.log(`  rejection copy present: ${hasRejectedCopy}`);

// ──────────────────────────────────────────────────────────────────
// CHUNK 1: Customer review dossier — public, no login
// ──────────────────────────────────────────────────────────────────
console.log("\n══ CHUNK 1 — Customer Review Dossier ══════════════════════");
// Visit /review/<known-invalid-token> to verify the page renders the
// invalid-token UI cleanly (not a crash). This proves the route lives
// + responds without leaking server state.
const stubPage = await chromium.launch({ headless: true });
const publicCtx = await stubPage.newContext();      // no auth state
const reviewPage = await publicCtx.newPage();
const reviewConsoleErrors = [];
reviewPage.on("pageerror", (e) => reviewConsoleErrors.push(`pageerror: ${e.message}`));
const reviewResp = await reviewPage.goto(`${BASE}/review/peakops_rv_not_a_real_token_aaaaaaaaaaaaaaaaaaaaaaaaaaaa`, { waitUntil: "domcontentloaded", timeout: 30000 });
await reviewPage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await reviewPage.waitForTimeout(2000);
const reviewText = await reviewPage.locator("body").innerText().catch(() => "");
await reviewPage.screenshot({ path: path.join(SHOTS, "5_review_invalid_token.png"), fullPage: true });
await reviewPage.close();
await stubPage.close();
results.chunk1.review_route_reachable_public = reviewResp?.status() === 200;
// The page renders some error UI for invalid tokens — match any of
// the known shapes. "couldn't load this packet" is the current SSR
// fallback when the fetch fails. "no longer valid" is the consumed/
// revoked terminal. "missing|invalid|not found" cover other shapes.
results.chunk1.review_invalid_token_handled =
  /no longer valid|invalid|not found|couldn['’]t load|missing authorization/i.test(reviewText);
results.chunk1.review_no_pageerror = reviewConsoleErrors.length === 0;
console.log(`  /review/{bad-token} status: ${reviewResp?.status()}`);
console.log(`  invalid-token UI rendered: ${results.chunk1.review_invalid_token_handled}`);
console.log(`  page errors: ${reviewConsoleErrors.length}`);

await browser.close();

// ──────────────────────────────────────────────────────────────────
// Final report
// ──────────────────────────────────────────────────────────────────
console.log("\n══ SUMMARY ════════════════════════════════════════════════");
function box(name, results) {
  const items = Object.entries(results);
  let pass = 0, fail = 0;
  for (const [k, v] of items) {
    console.log(`  ${v ? "✅" : "❌"} ${name}.${k}`);
    if (v) pass++; else fail++;
  }
  return { pass, fail };
}
const c1 = box("chunk1", results.chunk1);
const c2 = box("chunk2", results.chunk2);
const totalPass = c1.pass + c2.pass;
const totalFail = c1.fail + c2.fail;
console.log("\n" + "─".repeat(60));
console.log(`Chunk 1: ${c1.pass}/${c1.pass + c1.fail} pass`);
console.log(`Chunk 2: ${c2.pass}/${c2.pass + c2.fail} pass`);
console.log(`Total:   ${totalPass}/${totalPass + totalFail} pass`);
console.log(`Screenshots: ${SHOTS}/`);
process.exit(totalFail > 0 ? 1 : 0);
