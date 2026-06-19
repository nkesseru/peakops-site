#!/usr/bin/env node
// Demo dry-run — walks 6 prospect-facing surfaces and captures
// screenshots + body text so the report-writer (Claude) can
// evaluate the live demo readiness without manual browsing.
//
// Read-only. No clicks beyond navigation. No writes.

import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(__dirname, ".auth.json");
const SHOTS = path.join(__dirname, "screenshots", "dryrun");
import { mkdirSync } from "node:fs";
mkdirSync(SHOTS, { recursive: true });

if (!existsSync(AUTH_FILE)) { console.error("✗ No auth state."); process.exit(2); }

const BASE = "https://app.peakops.app";
const ORG = "peakops-internal-alpha";

const STOPS = [
  { name: "1_dashboard",      url: `${BASE}/dashboard?orgId=${ORG}` },
  { name: "2_records",        url: `${BASE}/records?orgId=${ORG}` },
  { name: "3_active_record",  url: `${BASE}/incidents/demo_field_work_001?orgId=${ORG}` },
  { name: "3b_active_review", url: `${BASE}/incidents/demo_field_work_001/review?orgId=${ORG}` },
  { name: "3c_active_summary",url: `${BASE}/incidents/demo_field_work_001/summary?orgId=${ORG}` },
  { name: "4_rejected_record",url: `${BASE}/incidents/demo_rejected_001?orgId=${ORG}` },
  { name: "4b_recovery_queue",url: `${BASE}/recovery?orgId=${ORG}` },
  { name: "5_accepted_record",url: `${BASE}/incidents/inc_20260508_121451_acnew0?orgId=${ORG}` },
  { name: "5b_accepted_summary",url: `${BASE}/incidents/inc_20260508_121451_acnew0/summary?orgId=${ORG}` },
  { name: "6_draft_record",   url: `${BASE}/incidents/demo_draft_001?orgId=${ORG}` },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: AUTH_FILE });
const report = {};

for (const stop of STOPS) {
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  try {
    const resp = await page.goto(stop.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.locator("text=loading record details").waitFor({ state: "hidden", timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const text = await page.locator("body").innerText();
    await page.screenshot({ path: path.join(SHOTS, `${stop.name}.png`), fullPage: true });
    report[stop.name] = {
      url: stop.url,
      httpStatus: resp?.status() ?? null,
      text,
      consoleErrors,
    };
    console.log(`✓ ${stop.name}  (${text.length} chars, ${consoleErrors.length} console errors)`);
  } catch (e) {
    report[stop.name] = { url: stop.url, error: String(e?.message || e), consoleErrors };
    console.log(`✗ ${stop.name}  ${e?.message || e}`);
  }
  await page.close();
}

writeFileSync(path.join(SHOTS, "_report.json"), JSON.stringify(report, null, 2));
await browser.close();
console.log(`\nReport: ${path.join(SHOTS, "_report.json")}`);
console.log(`Screenshots: ${SHOTS}/`);
