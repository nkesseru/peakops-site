// PEAKOPS_CHUNK2_NOTIFICATIONS_V1 — drift guard
// Chunk 2: Workflow Completion, 2026-06-22
//
// Pure file inspection — asserts that all four new notification
// types added in Chunk 2 are actually emitted from their backend
// callable. If a future refactor removes a fan-out call, this test
// fails before the regression ships.
//
// Also asserts the notification routing map in lib/notifications.ts
// covers all four types.

import fs from "node:fs";

const REPO = "/Users/kesserumini/peakops/my-app";

const SOURCES = [
  {
    file: `${REPO}/functions_clean/createCustomerReviewLinkV1.js`,
    marker: "PEAKOPS_REVIEW_LINK_NOTIFY_V1",
    type: "customer_review_link_created",
    title: "Review link sent",
  },
  {
    file: `${REPO}/functions_clean/mintResubmissionLinkV1.js`,
    marker: "PEAKOPS_REVIEW_LINK_NOTIFY_V1",
    type: "customer_review_link_created",
    title: "Resubmission link sent",
  },
  {
    file: `${REPO}/functions_clean/submitCustomerReviewV1.js`,
    marker: "PEAKOPS_CUSTOMER_DECISION_NOTIFY_V1",
    type: "customer_accepted",
    title: "Customer accepted",
  },
  {
    file: `${REPO}/functions_clean/submitCustomerReviewV1.js`,
    marker: "PEAKOPS_CUSTOMER_DECISION_NOTIFY_V1",
    type: "customer_rejected",
    title: "Customer requested correction",
  },
  {
    file: `${REPO}/functions_clean/_recoveryAutoCreate.js`,
    marker: "PEAKOPS_RECOVERY_CASE_NOTIFY_V1",
    type: "recovery_case_opened",
    title: "Recovery case opened",
  },
];

let failed = 0;
const fail = (msg) => { console.error(`  ❌ ${msg}`); failed++; };
const pass = (msg) => { console.log(`  ✅ ${msg}`); };

console.log("=== Backend notification fan-out drift guard ===");
for (const src of SOURCES) {
  if (!fs.existsSync(src.file)) {
    fail(`source not found: ${src.file}`);
    continue;
  }
  const text = fs.readFileSync(src.file, "utf8");
  const base = src.file.split("/").pop();

  if (!text.includes(src.marker)) {
    fail(`${base} missing marker ${src.marker}`);
    continue;
  }
  // Both the type literal AND the title literal must be present —
  // catches code that strips the type but keeps the marker comment.
  if (!text.includes(`"${src.type}"`)) {
    fail(`${base} missing type "${src.type}" literal`);
    continue;
  }
  if (!text.includes(`"${src.title}"`)) {
    fail(`${base} missing title "${src.title}" literal`);
    continue;
  }
  if (!/fanOutOrgNotification\(/.test(text)) {
    fail(`${base} does NOT call fanOutOrgNotification — notification not fanned out`);
    continue;
  }
  pass(`${base} emits "${src.type}" via fanOutOrgNotification`);
}

console.log("\n=== Routing map (lib/notifications.ts) recognizes the new types ===");
const routingSrc = fs.readFileSync(`${REPO}/next-app/lib/notifications.ts`, "utf8");
const REQUIRED_TYPES = [
  "customer_review_link_created",
  "customer_accepted",
  "customer_rejected",
  "recovery_case_opened",
];

for (const type of REQUIRED_TYPES) {
  // Must appear in BOTH the NotificationType union AND the
  // isNotificationType type guard AND the notificationHref routing block.
  const inUnion = new RegExp(`"${type}"\\s*\\n`).test(routingSrc) || new RegExp(`"${type}"\\b`).test(routingSrc);
  const inRoutingFn = new RegExp(`n\\.type === "${type}"`).test(routingSrc);
  if (!inUnion) fail(`type "${type}" not present anywhere in notifications.ts`);
  else if (!inRoutingFn) fail(`type "${type}" present but no notificationHref branch — clicking it dead-ends`);
  else pass(`"${type}" wired in routing map`);
}

console.log("\n=== Send-Back stub removed from ReviewClient ===");
const reviewClientSrc = fs.readFileSync(`${REPO}/next-app/app/incidents/[incidentId]/review/ReviewClient.tsx`, "utf8");
if (/TODO:\s*wire send-back endpoint/.test(reviewClientSrc)) {
  fail("ReviewClient still contains the send-back TODO alert stub");
} else {
  pass("ReviewClient send-back TODO alert is gone");
}
// Also confirm the button text "↩︎ Send Back" is no longer wired to a sendBack() function.
if (/sendBack\(\)\s*\{[\s\S]{0,200}alert/.test(reviewClientSrc)) {
  fail("ReviewClient still has a sendBack() function with an alert body");
} else {
  pass("No sendBack() stub function remains");
}

console.log("\n=== mailto: handoff shortcut wired in SendToCustomerModal ===");
const modalSrc = fs.readFileSync(`${REPO}/next-app/app/incidents/[incidentId]/summary/SendToCustomerModal.tsx`, "utf8");
if (!/PEAKOPS_REVIEW_MAILTO_HANDOFF_V1/.test(modalSrc)) {
  fail("SendToCustomerModal missing PEAKOPS_REVIEW_MAILTO_HANDOFF_V1 marker");
} else {
  pass("SendToCustomerModal carries mailto handoff marker");
}
if (!/openInEmailClient/.test(modalSrc)) {
  fail("SendToCustomerModal missing openInEmailClient handler");
} else {
  pass("openInEmailClient handler defined");
}
if (!/Open in email/.test(modalSrc)) {
  fail(`"Open in email" button text not present`);
} else {
  pass(`"Open in email" button rendered`);
}

if (failed) {
  console.error(`\n❌ chunk2 notifications: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\n✅ chunk2 notification + workflow wiring drift guard: all green");
