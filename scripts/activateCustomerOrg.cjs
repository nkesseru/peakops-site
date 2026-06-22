#!/usr/bin/env node
// PEAKOPS_ACTIVATE_CUSTOMER_ORG_V1 (Chunk 3B-1, 2026-06-22)
//
// CS-runnable activation wrapper. Replaces the 5-step manual founder
// CLI dance with a single command:
//
//   node scripts/activateCustomerOrg.cjs \
//     --name="Butler America Telecom" \
//     --industry=telecom \
//     --admin-email=admin@butleramerica.com \
//     --admin-name="Sarah Butler" \
//     --timezone="America/New_York" \
//     --teammate=field1@butleramerica.com:field \
//     --teammate=sup1@butleramerica.com:supervisor \
//     --apply
//
// Default mode is DRY-RUN: prints what would be created without
// touching production. Use --apply to execute.
//
// What it does:
//   1. POST /createOrgV1 → org + Auth user + claims + first-login URL
//   2. POST /inviteOrgMemberV1 per --teammate → Auth user + claims +
//      member doc + magic link
//   3. Print a summary table with orgId, all magic links, and a copy-
//      pasteable email template for the CS person.
//
// Service-account requirement:
//   Both callables are admin-gated. Either:
//     (a) FIREBASE_ID_TOKEN env var set to a Firebase ID token for a
//         user with peakopsInternalAdmin:true claim, OR
//     (b) GOOGLE_APPLICATION_CREDENTIALS pointing at a service account
//         (the script will mint an internal-admin token via Auth REST)
//
// Idempotent: re-running with the same --name produces the same orgId
// (slug of name). The first call succeeds; subsequent calls return
// { already: true } and report the existing state.

const fs = require("node:fs");
const path = require("node:path");

const PROJECT = process.env.PEAKOPS_PROJECT || "peakops-pilot";
const FN_BASE = `https://us-central1-${PROJECT}.cloudfunctions.net`;

const VALID_INDUSTRIES = ["utilities", "telecom", "municipality", "contractor", "other"];
const VALID_ROLES = ["admin", "supervisor", "field", "viewer"];   // owner is set by createOrgV1

function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }

// ── Argparse ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    name: null,
    industry: null,
    adminEmail: null,
    adminName: null,
    timezone: "UTC",
    teammates: [],
    apply: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "--apply") { out.apply = true; continue; }
    if (a.startsWith("--name=")) { out.name = a.slice(7); continue; }
    if (a.startsWith("--industry=")) { out.industry = a.slice(11); continue; }
    if (a.startsWith("--admin-email=")) { out.adminEmail = a.slice(14).toLowerCase(); continue; }
    if (a.startsWith("--admin-name=")) { out.adminName = a.slice(13); continue; }
    if (a.startsWith("--timezone=")) { out.timezone = a.slice(11); continue; }
    if (a.startsWith("--teammate=")) {
      const v = a.slice(11);
      const [email, role] = v.split(":");
      if (!email || !role) {
        console.error(red(`✗ --teammate must be in form email:role (got "${v}")`));
        process.exit(2);
      }
      out.teammates.push({ email: email.toLowerCase().trim(), role: role.toLowerCase().trim() });
      continue;
    }
    console.error(red(`✗ unknown arg: ${a}`));
    process.exit(2);
  }
  return out;
}

function printHelp() {
  console.log(`PeakOps customer activation — single-command provisioning.

Usage:
  node scripts/activateCustomerOrg.cjs \\
    --name="<Customer Org Name>" \\
    --industry=<${VALID_INDUSTRIES.join("|")}> \\
    --admin-email=<owner@customer.com> \\
    [--admin-name="<Sarah Butler>"] \\
    [--timezone="<IANA TZ; default UTC>"] \\
    [--teammate=<email>:<${VALID_ROLES.join("|")}>] \\
    [--teammate=...]   (repeatable)
    [--apply]          (default: dry-run; print plan without executing)

Examples:
  # Dry-run preview (recommended first):
  node scripts/activateCustomerOrg.cjs \\
    --name="Butler America Telecom" --industry=telecom \\
    --admin-email=admin@butleramerica.com

  # Execute:
  node scripts/activateCustomerOrg.cjs \\
    --name="Butler America Telecom" --industry=telecom \\
    --admin-email=admin@butleramerica.com \\
    --admin-name="Sarah Butler" \\
    --teammate=field1@butleramerica.com:field \\
    --teammate=sup1@butleramerica.com:supervisor \\
    --apply

Environment:
  FIREBASE_ID_TOKEN     ID token for a user with peakopsInternalAdmin:true claim
  PEAKOPS_PROJECT       Override project (default: peakops-pilot)
`);
}

function validate(args) {
  const errs = [];
  if (!args.name) errs.push("--name required");
  if (!args.industry) errs.push("--industry required");
  if (!args.adminEmail) errs.push("--admin-email required");
  if (args.industry && !VALID_INDUSTRIES.includes(args.industry)) {
    errs.push(`--industry must be one of: ${VALID_INDUSTRIES.join(", ")}`);
  }
  if (args.adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.adminEmail)) {
    errs.push(`--admin-email is not a valid email: ${args.adminEmail}`);
  }
  for (const t of args.teammates) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.email)) {
      errs.push(`teammate email is not valid: ${t.email}`);
    }
    if (!VALID_ROLES.includes(t.role)) {
      errs.push(`teammate role "${t.role}" must be one of: ${VALID_ROLES.join(", ")}`);
    }
  }
  return errs;
}

// ── Auth: get a Bearer token for the admin-gated callables ────────
function getIdToken() {
  const t = String(process.env.FIREBASE_ID_TOKEN || "").trim();
  if (!t) {
    console.error(red("✗ FIREBASE_ID_TOKEN env var is required."));
    console.error(dim("  Mint an ID token for an account with peakopsInternalAdmin:true claim."));
    console.error(dim("  (Sign in via gcloud / a CI service token / etc.)"));
    process.exit(3);
  }
  return t;
}

async function callFn(fn, body, idToken) {
  const r = await fetch(`${FN_BASE}/${fn}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: parsed || text };
}

// ── Dry-run plan formatter ────────────────────────────────────────
function expectedOrgId(name) {
  const raw = String(name == null ? "" : name).trim().toLowerCase();
  return raw
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function printPlan(args) {
  const orgId = expectedOrgId(args.name);
  console.log(bold("\n── Activation plan ─────────────────────────────────────────"));
  console.log(`  Customer name:    ${args.name}`);
  console.log(`  Derived orgId:    ${green(orgId)}`);
  console.log(`  Industry:         ${args.industry}`);
  console.log(`  Timezone:         ${args.timezone}`);
  console.log(`  Owner / admin:    ${args.adminEmail}${args.adminName ? `  (${args.adminName})` : ""}`);
  if (args.teammates.length === 0) {
    console.log(`  Teammates:        ${dim("(none)")}`);
  } else {
    console.log(`  Teammates (${args.teammates.length}):`);
    for (const t of args.teammates) {
      console.log(`    • ${t.email}  ${dim("→")}  ${t.role}`);
    }
  }
  console.log(`  Mode:             ${args.apply ? red("APPLY (writes will land)") : yellow("DRY-RUN (no writes)")}`);
  console.log("");
  console.log("  Will call:");
  console.log(`    1. POST /createOrgV1            → ${green("creates")} the org + owner Auth user + claims`);
  for (let i = 0; i < args.teammates.length; i++) {
    console.log(`    ${i + 2}. POST /inviteOrgMemberV1     → invites ${args.teammates[i].email} as ${args.teammates[i].role}`);
  }
  console.log("");
}

function printEmailTemplate({ orgId, adminEmail, firstLoginUrl }) {
  console.log(bold("\n── Email template (copy and send to customer admin) ───────"));
  console.log(dim("------------------------------------------------------------"));
  console.log(`To: ${adminEmail}`);
  console.log(`Subject: Welcome to PeakOps — your workspace is ready`);
  console.log(``);
  console.log(`Hi,`);
  console.log(``);
  console.log(`Your PeakOps workspace is provisioned and ready to use.`);
  console.log(``);
  console.log(`First-login link (single-use, expires in 1 hour):`);
  console.log(`${firstLoginUrl || "(generate via /admin → password reset if missing)"}`);
  console.log(``);
  console.log(`Org ID: ${orgId}`);
  console.log(``);
  console.log(`When you sign in, you'll land on the /onboarding wizard — walk`);
  console.log(`through the 7 steps to set your industry, workflow templates,`);
  console.log(`and invite your team. We'll be in touch at Day 7 to check in.`);
  console.log(``);
  console.log(`— PeakOps`);
  console.log(dim("------------------------------------------------------------"));
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  const errs = validate(args);
  if (errs.length > 0) {
    console.error(red("✗ Argument errors:"));
    for (const e of errs) console.error(red(`  - ${e}`));
    console.error("");
    printHelp();
    process.exit(2);
  }

  printPlan(args);

  if (!args.apply) {
    console.log(yellow("Dry-run complete. Re-run with --apply to execute."));
    process.exit(0);
  }

  const idToken = getIdToken();

  // ── Step 1: createOrgV1 ───────────────────────────────────────
  console.log(bold("\n── Step 1: createOrgV1 ────────────────────────────────────"));
  const createBody = {
    orgName: args.name,
    industry: args.industry,
    ownerEmail: args.adminEmail,
    ...(args.adminName ? { ownerName: args.adminName } : {}),
    timezone: args.timezone,
  };
  process.stdout.write(`  POST /createOrgV1 ... `);
  const t0 = Date.now();
  const r = await callFn("createOrgV1", createBody, idToken);
  console.log(`HTTP ${r.status} (${Date.now() - t0}ms)`);
  if (r.status >= 300 || (r.body && r.body.ok === false)) {
    console.error(red(`✗ createOrgV1 failed: ${JSON.stringify(r.body).slice(0, 300)}`));
    process.exit(4);
  }
  const {
    orgId, ownerUid, authUserCreated, firstLoginUrl, already,
  } = r.body;
  console.log(`  ${green("✓")} orgId:           ${orgId}`);
  console.log(`  ${green("✓")} ownerUid:        ${ownerUid}`);
  console.log(`  ${green("✓")} Auth user:       ${authUserCreated ? "created new" : "already existed"}`);
  console.log(`  ${green("✓")} Already exists:  ${already ? "yes" : "no"}`);

  // ── Steps 2..N: inviteOrgMemberV1 per teammate ────────────────
  const inviteResults = [];
  for (let i = 0; i < args.teammates.length; i++) {
    const t = args.teammates[i];
    console.log(bold(`\n── Step ${i + 2}: inviteOrgMemberV1  (${t.email} as ${t.role})`));
    const inviteBody = { orgId, email: t.email, role: t.role };
    process.stdout.write(`  POST /inviteOrgMemberV1 ... `);
    const t1 = Date.now();
    const ir = await callFn("inviteOrgMemberV1", inviteBody, idToken);
    console.log(`HTTP ${ir.status} (${Date.now() - t1}ms)`);
    if (ir.status >= 300 || (ir.body && ir.body.ok === false)) {
      console.error(red(`✗ inviteOrgMemberV1 failed for ${t.email}: ${JSON.stringify(ir.body).slice(0, 200)}`));
      // Continue with remaining teammates — partial failure isn't fatal.
      inviteResults.push({ teammate: t, error: ir.body, ok: false });
      continue;
    }
    inviteResults.push({
      teammate: t,
      uid: ir.body.uid,
      magicLink: ir.body.magicLink,
      authUserCreated: ir.body.authUserCreated,
      already: ir.body.already,
      ok: true,
    });
    console.log(`  ${green("✓")} uid:             ${ir.body.uid}`);
    console.log(`  ${green("✓")} Auth user:       ${ir.body.authUserCreated ? "created new" : "already existed"}`);
    console.log(`  ${green("✓")} Already member:  ${ir.body.already ? "yes" : "no"}`);
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log(bold("\n══════════════════════════════════════════════════════════════════"));
  console.log(bold(" ACTIVATION COMPLETE"));
  console.log(bold("══════════════════════════════════════════════════════════════════"));
  console.log(`Org ID:           ${green(orgId)}`);
  console.log(`Owner email:      ${args.adminEmail}`);
  console.log(`Owner UID:        ${ownerUid}`);
  console.log(`Teammates:        ${inviteResults.filter((x) => x.ok).length}/${args.teammates.length} invited successfully`);
  if (inviteResults.some((x) => !x.ok)) {
    console.log(red(`Failures:         ${inviteResults.filter((x) => !x.ok).length}`));
  }
  console.log(``);
  console.log(bold("Magic links (give one to each person — single-use, 1-hour TTL):"));
  console.log(`  ${args.adminEmail}: ${dim(firstLoginUrl || "(no link generated — run teamRecoveryV1)")}`);
  for (const ir of inviteResults) {
    if (!ir.ok) {
      console.log(`  ${ir.teammate.email}: ${red("FAILED")}`);
    } else {
      console.log(`  ${ir.teammate.email}: ${dim(ir.magicLink || "(no link — run teamRecoveryV1)")}`);
    }
  }

  // ── Email template for the admin ─────────────────────────────
  printEmailTemplate({ orgId, adminEmail: args.adminEmail, firstLoginUrl });

  process.exit(inviteResults.some((x) => !x.ok) ? 5 : 0);
}

main().catch((e) => {
  console.error(red("\n✗ Unhandled error:"));
  console.error(red(String(e?.stack || e?.message || e)));
  process.exit(99);
});
