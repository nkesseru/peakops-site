#!/usr/bin/env node
// PeakOps production demo-flow smoke test.
//
// Drives Chromium against the live https://app.peakops.app site as a
// signed-in operator and verifies the demo path renders correctly:
// expected lifecycle labels present, forbidden stale labels absent,
// no red console errors, screenshots captured per page.
//
// Auth: storageState pattern. First run requires a one-time manual
// login to capture cookies + IndexedDB (where Firebase keeps its
// refresh token). After that, every subsequent run is fully
// automated.
//
//   node smoke.mjs --login    Opens a headed browser. Log in, land
//                             on /dashboard, then press Enter in this
//                             terminal to save the auth state to
//                             .auth.json. ~30 sec one-time setup.
//
//   node smoke.mjs            Headless smoke run using saved auth.
//                             Exits 0 on PASS, 1 on FAIL, 2 on
//                             missing auth state.
//
// Output:
//   - Console: PASS/FAIL summary per page + console error tally
//   - screenshots/<page>.png  Full-page screenshot per check
//   - Exit code: 0 (all pass) / 1 (any fail) / 2 (auth missing)
//
// Re-runnable: each invocation is independent and idempotent.

import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(__dirname, ".auth.json");
const SHOTS_DIR = path.join(__dirname, "screenshots");

const BASE = "https://app.peakops.app";
const ORG = "peakops-internal-alpha";
const HERO_INCIDENT = "inc_20260508_121451_acnew0";

const MODE = process.argv.includes("--login") ? "login" : "smoke";

if (!existsSync(SHOTS_DIR)) mkdirSync(SHOTS_DIR, { recursive: true });

// ─── login mode ────────────────────────────────────────────────────
if (MODE === "login") {
  console.log("Opening Chromium in headed mode for one-time auth capture…");
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  console.log("");
  console.log("──────────────────────────────────────────────────────────");
  console.log("Log in to PeakOps in the opened browser window.");
  console.log("Navigate to any signed-in page (e.g. /dashboard).");
  console.log("Then return here and press Enter to capture + exit.");
  console.log("──────────────────────────────────────────────────────────");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question("", resolve));
  rl.close();
  await ctx.storageState({ path: AUTH_FILE });
  console.log(`\n✓ Saved auth state to ${AUTH_FILE}`);
  console.log("  Subsequent `npm run smoke` calls will use this state.");
  console.log("  Re-run --login if your session expires (Firebase refresh token TTL).");
  await browser.close();
  process.exit(0);
}

// ─── smoke mode ────────────────────────────────────────────────────
if (!existsSync(AUTH_FILE)) {
  console.error("");
  console.error("✗ No auth state file found at:");
  console.error(`    ${AUTH_FILE}`);
  console.error("");
  console.error("  Run once to capture:");
  console.error("    npm run login");
  console.error("");
  console.error("  Then re-run:");
  console.error("    npm run smoke");
  console.error("");
  process.exit(2);
}

function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: AUTH_FILE });

const results = [];
const allConsoleErrors = [];

async function checkPage({ name, url, expected = [], forbidden = [] }) {
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(`console.error: ${msg.text().slice(0, 200)}`);
  });
  page.on("pageerror", (err) => pageErrors.push(`pageerror: ${err.message}`));

  let httpStatus = null;
  let navError = null;
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    httpStatus = resp?.status() ?? null;
    // Wait for hydration + any client-side fetches to settle.
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
  } catch (e) {
    navError = String(e?.message || e);
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const shotPath = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

  // Detect login-redirect (auth state expired / cookies stale).
  const looksLikeLogin = /sign in to peakops|continue with google|sign in/i.test(bodyText) && !bodyText.includes("Sign out");

  const expectedMisses = expected.filter((s) => !bodyText.includes(s));
  const forbiddenHits = forbidden.filter((s) => bodyText.includes(s));

  const pass = !navError && !looksLikeLogin && expectedMisses.length === 0 && forbiddenHits.length === 0;
  results.push({
    name, url, pass, httpStatus, navError, looksLikeLogin,
    expectedMisses, forbiddenHits, errors: pageErrors, screenshot: shotPath,
  });
  allConsoleErrors.push(...pageErrors.map((e) => `${name}: ${e}`));
  await page.close();
}

console.log(dim(`Smoke run @ ${new Date().toISOString()}  base=${BASE}  org=${ORG}\n`));

// ─── checks ────────────────────────────────────────────────────────
await checkPage({
  name: "1_dashboard",
  url: `${BASE}/dashboard?orgId=${ORG}`,
  expected: ["In Progress", "Total Records", "Active", "Accepted", "Customer Accepted"],
  forbidden: ["Needs Review", "Approved KPI"],  // old KPI labels
});

await checkPage({
  name: "2_incident_overview",
  url: `${BASE}/incidents/${HERO_INCIDENT}?orgId=${ORG}`,
  expected: ["Customer Accepted"],
  forbidden: [
    "Awaiting customer review",
    "Add proof",
    "Capture proof",
    "Proof package incomplete",
  ],
});

await checkPage({
  name: "3_incident_review",
  url: `${BASE}/incidents/${HERO_INCIDENT}/review?orgId=${ORG}`,
  expected: ["Nothing is waiting for your review.", "View Summary"],
  forbidden: [
    "Send Back",
    "Approve & Lock Selected Job",
    "status=complete/review",
  ],
});

await checkPage({
  name: "4_incident_summary",
  url: `${BASE}/incidents/${HERO_INCIDENT}/summary?orgId=${ORG}`,
  expected: ["Customer Accepted"],
  forbidden: [
    "UP TO DATE",
    "OUT OF DATE",
    "REJECTION RECORDED",
    "AWAITING REVIEW",
    "version pre-slice-3",
    "slice 3",
  ],
});

await checkPage({
  name: "5_records",
  url: `${BASE}/records?orgId=${ORG}`,
  expected: ["All", "In Progress", "Active", "Accepted"],
  forbidden: ["Pending approval"],
});

await browser.close();

// ─── report ────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════");
console.log("PRODUCTION SMOKE TEST — DEMO FLOW");
console.log("══════════════════════════════════════════════════════════════════");

let passed = 0, failed = 0;
for (const r of results) {
  const tag = r.pass ? green("✓ PASS") : red("✗ FAIL");
  console.log(`\n${tag}  ${r.name}  (HTTP ${r.httpStatus ?? "?"})`);
  console.log(`  url: ${dim(r.url)}`);
  if (r.navError) console.log(`  ${red("nav error")}: ${r.navError}`);
  if (r.looksLikeLogin) console.log(`  ${red("auth state expired")} — re-run \`npm run login\``);
  if (r.expectedMisses.length) console.log(`  ${red("missing expected")}: ${r.expectedMisses.map((s) => JSON.stringify(s)).join(", ")}`);
  if (r.forbiddenHits.length) console.log(`  ${red("found forbidden")}: ${r.forbiddenHits.map((s) => JSON.stringify(s)).join(", ")}`);
  if (r.errors.length) {
    console.log(`  ${yellow(`${r.errors.length} console error(s)`)}:`);
    r.errors.slice(0, 3).forEach((e) => console.log(`    - ${e.slice(0, 200)}`));
    if (r.errors.length > 3) console.log(`    … and ${r.errors.length - 3} more`);
  }
  console.log(`  screenshot: ${r.screenshot}`);
  if (r.pass) passed++; else failed++;
}

console.log("\n──────────────────────────────────────────────────────────────────");
console.log(`Summary: ${passed} passed, ${failed} failed`);
console.log(`Console errors total: ${allConsoleErrors.length}`);
console.log(`Screenshots folder: ${SHOTS_DIR}`);
console.log("──────────────────────────────────────────────────────────────────\n");

process.exit(failed > 0 ? 1 : 0);
