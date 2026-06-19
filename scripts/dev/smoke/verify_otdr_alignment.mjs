#!/usr/bin/env node
// Focused after-screenshot probe for OTDR record alignment.
// Captures the rejected-record Overview + Recovery Queue and asserts:
//  - Work package title now reads "OTDR validation — East Ring fiber segment"
//  - No "Pole #4892" reference remains
//  - Recovery Queue still shows the case + "Missing test result" cause
//  - Customer Rejected status preserved

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(__dirname, ".auth.json");
const SHOTS = path.join(__dirname, "screenshots", "dryrun");

if (!existsSync(AUTH_FILE)) { console.error("✗ No auth state."); process.exit(2); }

const BASE = "https://app.peakops.app";
const ORG = "peakops-internal-alpha";
const INC = "demo_rejected_001";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: AUTH_FILE });

async function visit(url, shot) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.locator("text=loading record details").waitFor({ state: "hidden", timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const text = await page.locator("body").innerText();
  await page.screenshot({ path: path.join(SHOTS, `${shot}.png`), fullPage: true });
  await page.close();
  return text;
}

const rec = await visit(`${BASE}/incidents/${INC}?orgId=${ORG}`, "4_rejected_record_AFTER");
const recoveryQ = await visit(`${BASE}/recovery?orgId=${ORG}`, "4b_recovery_queue_AFTER");

const checks = {
  "Job title shows 'OTDR validation — East Ring fiber segment'": rec.includes("OTDR validation — East Ring fiber segment"),
  "No 'Pole #4892' reference on Overview":                       !/pole #?4892/i.test(rec),
  "No 'climb + condition photos' phrase":                        !rec.toLowerCase().includes("climb + condition photos"),
  "Incident title unchanged":                                    rec.includes("OTDR validation — East Ring"),
  "Customer Rejected status preserved":                          /customer rejected/i.test(rec),
  "Recovery Queue still lists OTDR case":                        recoveryQ.includes("OTDR validation — East Ring"),
  "Recovery shows 'Missing test result' cause":                  recoveryQ.toLowerCase().includes("missing test result"),
};

console.log("\nOTDR record alignment verification:");
let fail = 0;
for (const [k, ok] of Object.entries(checks)) {
  console.log(`  ${ok ? "✓" : "✗"} ${k}`);
  if (!ok) fail++;
}
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${Object.keys(checks).length - fail}/${Object.keys(checks).length}`);
console.log(`Screenshots: ${SHOTS}/{4_rejected_record_AFTER,4b_recovery_queue_AFTER}.png`);
await browser.close();
process.exit(fail > 0 ? 1 : 0);
