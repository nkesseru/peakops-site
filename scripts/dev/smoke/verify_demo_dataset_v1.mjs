#!/usr/bin/env node
// Demo Dataset v1 verification — drives prod alpha through three
// operator surfaces (Dashboard / Records / Recovery) and asserts the
// three demo records render as specified, with hygiene filters still
// suppressing smoke/e2e artifacts.

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = path.join(__dirname, ".auth.json");
const SHOTS = path.join(__dirname, "screenshots");

if (!existsSync(AUTH_FILE)) {
  console.error("✗ No auth state. Run `npm run login` first.");
  process.exit(2);
}

const BASE = "https://app.peakops.app";
const ORG = "peakops-internal-alpha";

const SPEC = {
  A: { id: "demo_field_work_001", title: "Fiber splice verification — Segment 14", customer: "Cascade Fiber Networks",  status: "In Progress",      evidence: 4 },
  B: { id: "demo_rejected_001",   title: "OTDR validation — East Ring",            customer: "Riverbend Power & Light", status: "Customer Rejected", evidence: 3 },
  C: { id: "demo_draft_001",      title: "Cabinet inspection — North Spokane",     customer: "Pioneer Broadband",       status: "Draft",             evidence: 0 },
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState: AUTH_FILE });

async function visit(url, shot) {
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.locator("text=loading record details").waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const text = await page.locator("body").innerText();
  await page.screenshot({ path: path.join(SHOTS, `${shot}.png`), fullPage: true });
  await page.close();
  return { text, lower: text.toLowerCase(), errors: consoleErrors };
}

const FORBIDDEN_HYGIENE = [
  "e2e recovery",
  "e2e version-pin",
  "pr108-smoke",
  "pr120-smoke",
  "smoke pr85-87",
  "dummy-fake",
];

console.log("Demo Dataset v1 verification — alpha");
console.log("─".repeat(64));

// ── Dashboard ────────────────────────────────────────────────────
const dash = await visit(`${BASE}/dashboard?orgId=${ORG}`, "demo_dash");
const dashChecks = {
  "A title visible":          dash.lower.includes(SPEC.A.title.toLowerCase()),
  "A customer visible":       dash.lower.includes(SPEC.A.customer.toLowerCase()),
  "B title visible":          dash.lower.includes(SPEC.B.title.toLowerCase()),
  "B customer visible":       dash.lower.includes(SPEC.B.customer.toLowerCase()),
  "C title visible":          dash.lower.includes(SPEC.C.title.toLowerCase()),
  "C customer visible":       dash.lower.includes(SPEC.C.customer.toLowerCase()),
  "KPI labels present":       ["in progress", "total records", "active", "accepted"].every((s) => dash.lower.includes(s)),
  "Hygiene: no smoke artifacts": !FORBIDDEN_HYGIENE.some((s) => dash.lower.includes(s)),
  "No console errors":        dash.errors.length === 0,
};

// ── Records ──────────────────────────────────────────────────────
const recs = await visit(`${BASE}/records?orgId=${ORG}`, "demo_records");
const recsChecks = {
  "A title visible":          recs.lower.includes(SPEC.A.title.toLowerCase()),
  "B title visible":          recs.lower.includes(SPEC.B.title.toLowerCase()),
  "C title visible":          recs.lower.includes(SPEC.C.title.toLowerCase()),
  "Active chip present":      recs.lower.includes("active"),
  "In Progress chip present": recs.lower.includes("in progress"),
  "Accepted chip present":    recs.lower.includes("accepted"),
  "Hygiene: no smoke artifacts": !FORBIDDEN_HYGIENE.some((s) => recs.lower.includes(s)),
  "No console errors":        recs.errors.length === 0,
};

// ── Recovery ─────────────────────────────────────────────────────
const rec = await visit(`${BASE}/recovery?orgId=${ORG}`, "demo_recovery");
const recChecks = {
  "B (rejected) visible in Recovery": rec.lower.includes(SPEC.B.title.toLowerCase()) || rec.lower.includes(SPEC.B.customer.toLowerCase()),
  "Missing test result cause":        rec.lower.includes("missing") && (rec.lower.includes("test") || rec.lower.includes("otdr")),
  "No console errors":                rec.errors.length === 0,
};

function table(name, checks) {
  console.log(`\n${name}`);
  let pass = 0, fail = 0;
  for (const [k, ok] of Object.entries(checks)) {
    console.log(`  ${ok ? "✓" : "✗"} ${k}`);
    if (ok) pass++; else fail++;
  }
  return { pass, fail };
}

const dr = table("DASHBOARD", dashChecks);
const rr = table("RECORDS", recsChecks);
const cr = table("RECOVERY", recChecks);

if (dash.errors.length) console.log("\nDashboard console errors:", dash.errors);
if (recs.errors.length) console.log("Records console errors:", recs.errors);
if (rec.errors.length) console.log("Recovery console errors:", rec.errors);

await browser.close();

const totalFail = dr.fail + rr.fail + cr.fail;
console.log("\n" + "─".repeat(64));
console.log(`Total: ${dr.pass + rr.pass + cr.pass} passed, ${totalFail} failed`);
console.log(`Screenshots: ${SHOTS}/demo_{dash,records,recovery}.png`);
process.exit(totalFail > 0 ? 1 : 0);
