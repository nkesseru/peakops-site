#!/usr/bin/env node
// Chunk 3B-1 — generatePasswordResetLink root-cause diagnostic.
//
// Calls Admin SDK generatePasswordResetLink LOCALLY (with service-
// account creds, same code path as the Cloud Function would take)
// against several actionCodeSettings shapes. For each, captures:
//   - The exact URL passed
//   - The exact host parsed from that URL
//   - The exact Firebase project ID resolved from the service account
//   - The full Firebase error object on failure
//
// Read-only. Creates one test user, runs the variants, deletes the user.
// No code changes to the deployed function.

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const SA_PATH = "/Users/kesserumini/peakops/my-app/.secrets/sa.json";
const saJson = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(saJson),
  projectId: saJson.project_id,
});

console.log("══ Diagnostic context ═════════════════════════════════");
console.log(`  Service-account project_id : ${saJson.project_id}`);
console.log(`  Service-account client_email: ${saJson.client_email}`);
console.log("");

const tag = randomBytes(2).toString("hex");
const TEST_EMAIL = `chunk3b1-diag-${tag}@peakops-test.example.com`;

// Make sure the user exists (Auth requires the user to exist for
// generatePasswordResetLink to succeed).
let testUid = null;
try {
  const u = await admin.auth().getUserByEmail(TEST_EMAIL);
  testUid = u.uid;
} catch (_) {
  const u = await admin.auth().createUser({ email: TEST_EMAIL });
  testUid = u.uid;
}
console.log(`  Test user uid: ${testUid}`);
console.log(`  Test user email: ${TEST_EMAIL}`);
console.log("");

// The exact variants we want to test. Each captures what's actually
// being passed and what comes back.
const VARIANTS = [
  {
    label: "A. Function-default (no env var, no headers — falls back to hardcoded https://app.peakops.app)",
    url: "https://app.peakops.app/auth/action",
    handleCodeInApp: true,
  },
  {
    label: "B. Same URL, handleCodeInApp:false (rules out mobile-app code-handling)",
    url: "https://app.peakops.app/auth/action",
    handleCodeInApp: false,
  },
  {
    label: "C. Apex peakops.app (just added by user)",
    url: "https://peakops.app/auth/action",
    handleCodeInApp: true,
  },
  {
    label: "D. No URL at all (Firebase falls back to default project auth domain)",
    // intentionally undefined
  },
  {
    label: "E. Default Firebase Auth domain (always allowlisted)",
    url: `https://${saJson.project_id}.firebaseapp.com/__/auth/handler`,
    handleCodeInApp: true,
  },
];

async function runVariant(variant) {
  console.log(`── ${variant.label} ──`);
  let acs = null;
  if (variant.url !== undefined) {
    acs = { url: variant.url, handleCodeInApp: !!variant.handleCodeInApp };
    let host = "";
    try { host = new URL(variant.url).host; } catch {}
    console.log(`  url:               ${variant.url}`);
    console.log(`  parsed host:       ${host}`);
    console.log(`  handleCodeInApp:   ${variant.handleCodeInApp}`);
  } else {
    console.log(`  url:               (omitted — Firebase default)`);
  }
  try {
    const link = await (acs
      ? admin.auth().generatePasswordResetLink(TEST_EMAIL, acs)
      : admin.auth().generatePasswordResetLink(TEST_EMAIL));
    let linkHost = "";
    try { linkHost = new URL(link).host; } catch {}
    console.log(`  ✅ SUCCESS`);
    console.log(`     returned link host: ${linkHost}`);
    console.log(`     returned link (truncated): ${link.slice(0, 120)}...`);
  } catch (e) {
    console.log(`  ❌ FAILED`);
    console.log(`     code:    ${e.code || "(no code)"}`);
    console.log(`     message: ${e.message || String(e)}`);
    // Firebase error info often carries an errorInfo with serverResponse
    if (e.errorInfo) {
      console.log(`     errorInfo: ${JSON.stringify(e.errorInfo).slice(0, 400)}`);
    }
  }
  console.log("");
}

for (const v of VARIANTS) {
  await runVariant(v);
}

// Cleanup
try { await admin.auth().deleteUser(testUid); console.log(`Cleanup: deleted ${testUid}`); } catch {}
process.exit(0);
