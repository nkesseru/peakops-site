// PEAKOPS_DEMO_BRANDING_V1 (2026-05-12) — Slice Demo Branding 1.0.
//
// Brings muni / utility / contractor demo orgs up to telecom-alpha
// branding parity by writing industry-flavored SVG monogram logos
// to orgs/{org}.branding.logoUrl. The Summary header reads that
// same field — landing the logo via Admin SDK produces a render
// identical to what the Settings → Organization upload flow would
// produce.
//
// Logo design — abstract monogram + industry color:
//   muni       → forest green bg (#0d5e3a),  "PW" mark  (Public Works)
//   utility    → utility amber  (#b8862e),   "UO" mark  (Utility Ops)
//   contractor → industrial dk  (#1a1a1a),   "IC" mark  (Infrastructure Contractor)
// 200×200 rounded-corner SVG; renders crisp at the 48×48 Summary
// slot and any future larger slot. ~400 bytes each as a data URL.
// No real company logos referenced; no copyright risk; vector
// rendering scales without aliasing.
//
// What this script writes (when --apply is set):
//   For each of the three demo orgs:
//     orgs/{org}.branding.logoUrl ← data:image/svg+xml;base64,<svg>
//     orgs/{org}.updatedAt        ← serverTimestamp
//
// What it deliberately does NOT do:
//   - Does not touch peakops-internal-alpha (telecom branding is
//     the existing peakops PNG — explicit hard-refusal guard).
//   - Does not touch demo-org.
//   - Does not modify any other field.
//   - Does not delete or downgrade existing logos. If an org
//     already has a non-default logoUrl, the script reports it
//     and overwrites (re-runnable / idempotent).
//
// Also saves the source SVGs to dev-assets/branding/ for
// reference / future hand-upload if someone wants to swap.
//
// Usage:
//   node scripts/uploadDemoBranding.cjs            # dry-run
//   node scripts/uploadDemoBranding.cjs --apply    # write

"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");

const PROTECTED_ORGS = new Set(["peakops-internal-alpha", "demo-org"]);

// Industry → (org, monogram, colors). bgColor reads well on the
// dark Summary header chrome; fg picked for AA-ish contrast.
const BRANDS = [
  {
    label: "muni",
    org:   "peakops-internal-muni",
    mark:  "PW",
    bg:    "#0d5e3a",
    fg:    "#ffffff",
  },
  {
    label: "utility",
    org:   "peakops-internal-utility",
    mark:  "UO",
    bg:    "#b8862e",
    fg:    "#050505",
  },
  {
    label: "contractor",
    org:   "peakops-internal-contractor",
    mark:  "IC",
    bg:    "#1a1a1a",
    fg:    "#c8a84e",
  },
];

function buildSvg({ bg, fg, mark }) {
  // 200×200 rounded square with centered monogram. No <script>,
  // no external refs — pure-markup SVG that browsers handle cleanly
  // in <img src=...> data URLs.
  const fontStack = "-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">` +
    `<rect width="200" height="200" rx="32" ry="32" fill="${bg}"/>` +
    `<text x="100" y="135" text-anchor="middle" font-family="${fontStack}" ` +
    `font-size="84" font-weight="700" fill="${fg}" letter-spacing="-2">${mark}</text>` +
    `</svg>`
  );
}

function toDataUrl(svgText) {
  const b64 = Buffer.from(svgText, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
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

(async () => {
  const sa = loadServiceAccount();
  if (!sa) {
    console.error("[brand] no service account found");
    process.exit(1);
  }
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
  }
  console.log(`[brand] project=${sa.project_id} mode=${APPLY ? "APPLY" : "dry-run"}`);

  // Save SVGs to dev-assets/branding/ for reference + future hand-
  // upload via Settings → Organization. Creates the dir if needed.
  const assetsDir = path.resolve(__dirname, "..", "dev-assets", "branding");
  if (!fs.existsSync(assetsDir)) {
    if (APPLY) fs.mkdirSync(assetsDir, { recursive: true });
    console.log(`[brand] dev-assets/branding/ ${fs.existsSync(assetsDir) ? "exists" : "will be created on --apply"}`);
  }

  const db = admin.firestore();

  for (const b of BRANDS) {
    if (PROTECTED_ORGS.has(b.org)) {
      console.error(`[brand] SKIP ${b.org} — protected (alpha / demo-org branding is operator-owned).`);
      continue;
    }

    const svg = buildSvg(b);
    const dataUrl = toDataUrl(svg);

    console.log(`\n[brand] ${b.label.padEnd(10)} → ${b.org}`);
    console.log(`        mark="${b.mark}" bg=${b.bg} fg=${b.fg}`);
    console.log(`        svg bytes: ${Buffer.byteLength(svg, "utf8")}`);
    console.log(`        data URL bytes: ${dataUrl.length}`);

    // Save source SVG for reference (non-destructive — only writes
    // on --apply so a dry-run leaves the filesystem clean).
    if (APPLY) {
      const assetPath = path.join(assetsDir, `${b.label}-logo.svg`);
      fs.writeFileSync(assetPath, svg, "utf8");
      console.log(`        wrote source SVG → dev-assets/branding/${path.basename(assetPath)}`);
    }

    // Pre-read existing branding so we don't silently overwrite a
    // real upload.
    const orgRef = db.doc(`orgs/${b.org}`);
    const orgSnap = await orgRef.get();
    const orgData = orgSnap.exists ? (orgSnap.data() || {}) : {};
    const existing = orgData.branding && orgData.branding.logoUrl;
    if (existing) {
      const isExistingSvg = String(existing).startsWith("data:image/svg+xml");
      console.log(`        existing logoUrl: ${isExistingSvg ? "(svg monogram — will overwrite)" : "(non-monogram — will overwrite, but flagging)"}`);
    } else {
      console.log(`        existing logoUrl: (none)`);
    }

    if (!APPLY) {
      console.log(`        DRY RUN — would write branding.logoUrl (data URL, ${dataUrl.length} chars)`);
      continue;
    }

    await orgRef.set({
      branding: { logoUrl: dataUrl },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    const after = (await orgRef.get()).data() || {};
    const written = after.branding && after.branding.logoUrl;
    if (written === dataUrl) {
      console.log(`        ✓ wrote branding.logoUrl (${written.length} chars)`);
    } else {
      console.warn(`        ⚠ unexpected: written value differs from intended (${(written || "").length} chars vs ${dataUrl.length})`);
    }
  }

  if (!APPLY) {
    console.log(`\n[brand] DRY RUN complete — pass --apply to write.`);
  } else {
    console.log(`\n[brand] done.`);
    console.log(`[brand] Verify in Chrome:`);
    console.log(`  muni:       https://app.peakops.app/incidents/inc_20260511_205431_773c1b/summary?orgId=peakops-internal-muni`);
    console.log(`  utility:    https://app.peakops.app/incidents/inc_20260511_205446_c6bf95/summary?orgId=peakops-internal-utility`);
    console.log(`  contractor: https://app.peakops.app/incidents/inc_20260512_144713_340a05/summary?orgId=peakops-internal-contractor`);
    console.log(`[brand] Each 48x48 header logo slot should now show the industry monogram.`);
  }
  process.exit(0);
})().catch((e) => {
  console.error(`[brand] uncaught: ${e && e.stack ? e.stack : String(e)}`);
  process.exit(1);
});
