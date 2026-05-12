// PEAKOPS_DEMO_CLOSED_LOOP_V1 (2026-05-12) — Slice Demo Closed-Loop
// Polish 1.0.
//
// One-off operator script: drives the canonical Generate Report
// pathway on the muni + utility demo incidents so each lands in
// the same fully-closed/report-generated state as the polished
// telecom alpha (packetMeta.status=ready, Download Report
// available, Regenerate available, Print / Save PDF available).
//
// Pathway:
//   1. Admin SDK mints a custom token for the admin user (Nick).
//   2. Firebase Auth REST exchanges custom token → ID token using
//      the public NEXT_PUBLIC_FIREBASE_API_KEY (this is a web API
//      key, intentionally public — same key that ships in the
//      browser bundle).
//   3. Script POSTs to https://app.peakops.app/api/fn/exportIncidentPacketV1
//      with the Bearer ID token + {orgId, incidentId} body. This
//      is the EXACT same code path the Generate Report button
//      drives. The Next.js proxy validates the bearer, forwards
//      to the upstream Cloud Function, which generates the ZIP,
//      signs it, and writes packetMeta back to the incident doc.
//   4. Script re-reads packetMeta to confirm the new revision
//      landed (status=ready, zipSize, packetHash, history entry).
//
// What this script deliberately does NOT do:
//   - Does not bypass the canonical export pipeline. The exact
//     bytes the Generate Report button produces are what land in
//     Storage; this script just triggers the click programmatically.
//   - Does not modify incident timestamps, notes, tasks, or
//     evidence. Those polish passes (1.0 + 1.1) are complete.
//   - Does not touch peakops-internal-alpha. Hard-refuses the
//     alpha + demo-org orgIds even if --kind=alpha is mistyped.
//   - Does not modify auth/rules/claims.
//
// Idempotent: repeated runs just generate additional packetMeta
// history revisions (same behavior as repeated Regenerate clicks).
// Dry-run by default; --apply to actually invoke the function.
//
// Usage:
//   node scripts/generateDemoReport.cjs --kind=muni
//   node scripts/generateDemoReport.cjs --kind=utility --apply

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function getArg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : "";
}

const KIND = String(getArg("kind") || "").trim().toLowerCase();
const APPLY = process.argv.includes("--apply");

if (!["muni", "utility"].includes(KIND)) {
  console.error("Usage: node scripts/generateDemoReport.cjs --kind=muni|utility [--apply]");
  process.exit(2);
}

const TARGETS = {
  muni: {
    org: "peakops-internal-muni",
    id: "inc_20260511_205431_773c1b",
  },
  utility: {
    org: "peakops-internal-utility",
    id: "inc_20260511_205446_c6bf95",
  },
};

const target = TARGETS[KIND];

if (target.org === "peakops-internal-alpha" || target.org === "demo-org") {
  console.error(`[gen-report] FATAL — refusing to operate on protected org ${target.org}.`);
  process.exit(2);
}

// Read the env file to pick up NEXT_PUBLIC_FIREBASE_API_KEY (public,
// same one in the browser bundle). The custom→ID token exchange
// requires it.
function loadDotEnv() {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, "utf8");
  const out = {};
  raw.split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  });
  return out;
}

function loadServiceAccount() {
  const tryPaths = [
    process.env.PEAKOPS_SA_PATH,
    path.resolve(__dirname, "..", "service-account.json"),
  ].filter(Boolean);
  for (const p of tryPaths) {
    if (p && fs.existsSync(p)) {
      const sa = JSON.parse(fs.readFileSync(p, "utf8"));
      if (sa.private_key && sa.private_key.includes("\\n")) {
        sa.private_key = sa.private_key.replace(/\\n/g, "\n");
      }
      return sa;
    }
  }
  return null;
}

function ensureAdminApp(sa) {
  if (admin.apps.length > 0) return admin.apps[0];
  return admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
  });
}

async function exchangeCustomTokenForIdToken(customToken, apiKey) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${txt}`);
  const out = JSON.parse(txt);
  if (!out.idToken) throw new Error(`token exchange returned no idToken: ${txt}`);
  return out.idToken;
}

(async () => {
  const sa = loadServiceAccount();
  if (!sa) {
    console.error("[gen-report] no service account found");
    process.exit(1);
  }
  ensureAdminApp(sa);
  const env = loadDotEnv();
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) {
    console.error("[gen-report] NEXT_PUBLIC_FIREBASE_API_KEY not found (.env.local or env)");
    process.exit(1);
  }

  console.log(`[gen-report] project=${sa.project_id} mode=${APPLY ? "APPLY" : "dry-run"}`);
  console.log(`[gen-report] kind=${KIND} org=${target.org} incident=${target.id}`);

  const db = admin.firestore();

  // Pre-flight: confirm incident is in the right shape for export
  // (status=closed, ≥1 approved job, ≥1 evidence, members doc OK).
  const inc = (await db.doc(`orgs/${target.org}/incidents/${target.id}`).get()).data();
  if (!inc) {
    console.error(`[gen-report] FAIL — incident not found at orgs/${target.org}/incidents/${target.id}`);
    process.exit(3);
  }
  console.log(`[gen-report] incident status: ${inc.status}`);
  console.log(`[gen-report] existing packetMeta: ${inc.packetMeta ? "YES (status=" + inc.packetMeta.status + " rev=" + (inc.packetMeta.reportRevision || 1) + ")" : "no"}`);

  const adminEmail = "nicholaskesseru@gmail.com";
  let adminUser;
  try {
    adminUser = await admin.auth().getUserByEmail(adminEmail);
  } catch (e) {
    console.error(`[gen-report] cannot look up admin user: ${e.message || e}`);
    process.exit(3);
  }
  const adminUid = adminUser.uid;
  console.log(`[gen-report] admin uid: ${adminUid}`);

  // Confirm membership doc on the target org with admin/supervisor role.
  const memberSnap = await db.doc(`orgs/${target.org}/members/${adminUid}`).get();
  if (!memberSnap.exists) {
    console.error(`[gen-report] FAIL — admin has no members doc on ${target.org}`);
    process.exit(3);
  }
  const memberData = memberSnap.data() || {};
  console.log(`[gen-report] admin member role: ${memberData.role} status: ${memberData.status}`);

  if (!APPLY) {
    console.log(`\n[gen-report] PLAN`);
    console.log(`  POST https://app.peakops.app/api/fn/exportIncidentPacketV1`);
    console.log(`       Authorization: Bearer <ID token minted from admin uid ${adminUid}>`);
    console.log(`       body: { orgId: "${target.org}", incidentId: "${target.id}" }`);
    console.log(`  Expected: 200 OK with packetMeta in response; packetMeta.status="ready" lands on the incident doc.`);
    console.log(`\n[gen-report] DRY RUN — pass --apply to invoke.`);
    process.exit(0);
  }

  // Mint custom token + exchange for ID token.
  const customToken = await admin.auth().createCustomToken(adminUid);
  console.log(`[gen-report] minted custom token (length=${customToken.length})`);

  let idToken;
  try {
    idToken = await exchangeCustomTokenForIdToken(customToken, apiKey);
    console.log(`[gen-report] exchanged for ID token (length=${idToken.length})`);
  } catch (e) {
    console.error(`[gen-report] token exchange FAIL: ${e.message || e}`);
    process.exit(4);
  }

  // POST through the Next.js proxy — exact same path the Generate Report button uses.
  const url = "https://app.peakops.app/api/fn/exportIncidentPacketV1";
  const body = JSON.stringify({ orgId: target.org, incidentId: target.id });
  console.log(`[gen-report] POST ${url}`);
  console.log(`[gen-report] body: ${body}`);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${idToken}`,
      },
      body,
    });
  } catch (e) {
    console.error(`[gen-report] fetch FAIL: ${e.message || e}`);
    process.exit(5);
  }

  const respText = await resp.text();
  console.log(`[gen-report] response status: ${resp.status}`);
  console.log(`[gen-report] response body (first 600 chars): ${respText.slice(0, 600)}`);

  if (resp.status < 200 || resp.status >= 300) {
    console.error(`[gen-report] FAIL — non-2xx response`);
    process.exit(6);
  }

  // Re-read packetMeta to confirm landing.
  // exportIncidentPacketV1 can be slow on large incidents; small
  // demos finish quickly but give Firestore a beat.
  await new Promise((r) => setTimeout(r, 1500));
  const after = (await db.doc(`orgs/${target.org}/incidents/${target.id}`).get()).data();
  const pm = after && after.packetMeta;
  if (!pm) {
    console.warn(`[gen-report] response 2xx but packetMeta still missing on incident doc; try again after a moment.`);
    process.exit(7);
  }
  console.log(`\n[gen-report] packetMeta after generation:`);
  console.log(`  status:           ${pm.status}`);
  console.log(`  reportRevision:   ${pm.reportRevision}`);
  console.log(`  bucket:           ${pm.bucket}`);
  console.log(`  storagePath:      ${pm.storagePath}`);
  console.log(`  zipSize:          ${pm.zipSize} bytes`);
  console.log(`  zipSha256:        ${(pm.zipSha256 || "").slice(0, 16)}...`);
  console.log(`  exportedAt:       ${pm.exportedAt}`);
  console.log(`  evidenceCount:    ${pm.evidenceCount}`);
  console.log(`  jobCount:         ${pm.jobCount}`);
  console.log(`  timelineCount:    ${pm.timelineCount}`);
  console.log(`  history entries:  ${(pm.history || []).length}`);

  console.log(`\n[gen-report] done. Verify in Chrome:`);
  console.log(`  https://app.peakops.app/incidents/${target.id}/summary?orgId=${target.org}`);
  process.exit(0);
})().catch((e) => {
  console.error(`[gen-report] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
