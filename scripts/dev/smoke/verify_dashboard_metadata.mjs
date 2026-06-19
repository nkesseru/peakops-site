#!/usr/bin/env node
// One-off verification for commit af8ba2d (Dashboard Card Metadata Option C).
// Drives Chromium against live prod with saved auth state, checks the
// 8-item verification list from the operator brief, and exits 0 on pass.

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(__dirname, ".auth.json");
const SHOT = path.join(__dirname, "screenshots", "verify_dashboard_metadata.png");

if (!existsSync(AUTH_FILE)) {
  console.error("✗ No auth state. Run `npm run login` first.");
  process.exit(2);
}

const URL_ = "https://app.peakops.app/dashboard?orgId=peakops-internal-alpha";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: AUTH_FILE });
const page = await ctx.newPage();

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);

const body = await page.locator("body").innerText();
const bodyLower = body.toLowerCase();
await page.screenshot({ path: SHOT, fullPage: true });

const FORBIDDEN = [
  "latest job:",       // dropped subline
  "reviewable",        // dropped tile label
  "updated —",         // dropped footer
];
const EXPECTED_TILES = [
  "evidence",
  "customer",
  "priority",
  "last activity",
];
const EXPECTED_KPI = [
  "in progress",
  "total records",
  "active",
  "accepted",
];

const forbiddenHits = FORBIDDEN.filter((s) => bodyLower.includes(s));
// "approved" appears as KPI label ("Accepted" replaced "Approved" already,
// but the bucket section title still says "Approved"); we only forbid the
// "Approved 0" tile shape. So check the raw render block instead.
const approvedTileHit = /approved\s*\n?\s*0\b/i.test(body);

const missingTiles = EXPECTED_TILES.filter((s) => !bodyLower.includes(s));
const missingKpi = EXPECTED_KPI.filter((s) => !bodyLower.includes(s));

// Hero: the card uses i.title fallback; if hero rendered, the body should
// contain at least one of the staged real-record titles.
const heroPresent = /splice cabinet repair|pole inspection|aerial fiber pull|fiber splice verification/i.test(body);

const results = [
  ["1. No 'Latest job: —'",       !bodyLower.includes("latest job:")],
  ["2. No 'Reviewable 0' tile",   !/reviewable\s*\n?\s*\d/i.test(body)],
  ["3. No 'Approved 0' tile",     !approvedTileHit],
  ["4. No 'updated —' footer",    !bodyLower.includes("updated —")],
  ["5a. Evidence tile present",    bodyLower.includes("evidence")],
  ["5b. Customer tile present",    bodyLower.includes("customer")],
  ["5c. Priority tile present",    bodyLower.includes("priority")],
  ["5d. Last Activity tile present", bodyLower.includes("last activity")],
  ["6. KPI strip labels present",  missingKpi.length === 0],
  ["7. Hero card present",         heroPresent],
  ["8. No console errors",         consoleErrors.length === 0],
];

console.log("\nDashboard verification — commit af8ba2d");
console.log("URL:", URL_);
console.log("Screenshot:", SHOT);
console.log("");
let failed = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}
if (consoleErrors.length) {
  console.log("\nConsole errors:");
  consoleErrors.forEach((e) => console.log("  -", e));
}
if (forbiddenHits.length) {
  console.log("\nForbidden hits:", forbiddenHits);
}
if (missingKpi.length) console.log("Missing KPI:", missingKpi);
if (missingTiles.length) console.log("Missing tiles:", missingTiles);

await browser.close();
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${results.length - failed}/${results.length}`);
process.exit(failed > 0 ? 1 : 0);
