// Theory: when /createOrgV1 is called via its direct function URL,
// `req.headers.host` is the function's own hostname
// (e.g. "createorgv1-2omfo6m6ea-uc.a.run.app"). buildActionCodeSettings
// then constructs a URL with that host, which is NOT in the
// Authorized Domains list — hence "Domain not allowlisted by project".
//
// Proof: call generatePasswordResetLink LOCALLY with that exact host
// in the URL. If it fails with the same error, theory confirmed.

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");

const SA_PATH = "/Users/kesserumini/peakops/my-app/.secrets/sa.json";
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(SA_PATH, "utf8"))),
  projectId: "peakops-pilot",
});

const tag = randomBytes(2).toString("hex");
const email = `diag-host-theory-${tag}@peakops-test.example.com`;
const u = await admin.auth().createUser({ email });

// The exact hostname Cloud Run gave the createOrgV1 function (from
// deploy output): "createorgv1-2omfo6m6ea-uc.a.run.app".
// AND the gen2 function URL: "us-central1-peakops-pilot.cloudfunctions.net".
const HOSTS_TO_TEST = [
  "createorgv1-2omfo6m6ea-uc.a.run.app",
  "us-central1-peakops-pilot.cloudfunctions.net",
  "app.peakops.app",      // baseline — should succeed
];

for (const host of HOSTS_TO_TEST) {
  const url = `https://${host}/auth/action`;
  console.log(`\n── url: ${url}`);
  try {
    const link = await admin.auth().generatePasswordResetLink(email, {
      url,
      handleCodeInApp: true,
    });
    console.log(`  ✅ SUCCESS — returned link host: ${new URL(link).host}`);
  } catch (e) {
    console.log(`  ❌ FAILED`);
    console.log(`     code: ${e.code}`);
    console.log(`     message: ${e.message}`);
  }
}

await admin.auth().deleteUser(u.uid);
console.log(`\nCleanup: deleted ${u.uid}`);
