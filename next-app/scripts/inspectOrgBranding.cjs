// PEAKOPS_RBAC_INSPECT_BRANDING_V1 (2026-05-11)
// Read-only diagnostic: prints orgs/{orgId} branding state. Used to
// confirm whether branding.logoUrl was actually written, and what
// shape/size it has.
//
// Usage: node scripts/inspectOrgBranding.cjs --org=<orgId>
"use strict";
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

function getArg(name) {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : "";
}
const ORG = String(getArg("org") || "").trim();
if (!ORG) {
  console.error("Usage: node scripts/inspectOrgBranding.cjs --org=<orgId>");
  process.exit(2);
}

const saPaths = [
  process.env.PEAKOPS_SA_PATH,
  path.resolve(__dirname, "..", "service-account.json"),
].filter(Boolean);
let sa = null;
for (const p of saPaths) {
  if (p && fs.existsSync(p)) {
    sa = JSON.parse(fs.readFileSync(p, "utf8"));
    if (sa.private_key && sa.private_key.includes("\\n")) {
      sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    }
    break;
  }
}
if (!sa) {
  console.error("no service account found");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });

(async () => {
  const snap = await admin.firestore().doc(`orgs/${ORG}`).get();
  if (!snap.exists) {
    console.log(`org ${ORG} does not exist`);
    process.exit(0);
  }
  const data = snap.data() || {};
  console.log(`project: ${sa.project_id}`);
  console.log(`org: ${ORG}`);
  console.log(`name: ${data.name || "(none)"}`);
  console.log(`industry: ${data.industry || "(none)"}`);
  const branding = data.branding || null;
  console.log(`branding present: ${!!branding}`);
  const logoUrl = branding && typeof branding === "object" ? String(branding.logoUrl || "") : "";
  console.log(`branding.logoUrl present: ${!!logoUrl}`);
  if (logoUrl) {
    console.log(`logoUrl length: ${logoUrl.length}`);
    console.log(`logoUrl prefix: ${logoUrl.slice(0, 40)}`);
    console.log(`logoUrl is data: URL: ${logoUrl.startsWith("data:")}`);
    console.log(`logoUrl is https:: ${logoUrl.startsWith("https://")}`);
    if (logoUrl.startsWith("data:")) {
      const m = /^data:(image\/[a-z+]+);base64,/i.exec(logoUrl);
      console.log(`data URL mime: ${m ? m[1] : "(unparseable)"}`);
      const headLen = m ? m[0].length : 0;
      const b64 = logoUrl.slice(headLen);
      console.log(`approximate decoded bytes: ${Math.floor((b64.length * 3) / 4)}`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
