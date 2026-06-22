#!/usr/bin/env node
// PEAKOPS_CUSTOMER_REVIEW_TOKEN_TTL_V1 — Backfill migration
// Chunk 1: Trust Foundation, 2026-06-22
//
// Sets expiresAt on every existing customer_review_links doc that has
// expiresAt == null. New mints already populate expiresAt automatically.
//
// Two run modes:
//   --dry-run (default) — read every link doc, count null-TTL docs,
//                         print the proposed write, write nothing.
//   --apply             — execute the writes.
//
// Backfill policy (deliberately conservative, to avoid retro-revoking
// links that customers might still be holding):
//
//   - If link is consumed OR revoked → set expiresAt to createdAt + 7
//     days (the doc is terminal; expiresAt is for audit-symmetry only).
//   - Else → set expiresAt to NOW + 90 days (TOKEN_TTL_DAYS from
//     _customerReviewToken.js). This grandfathers active legacy links
//     forward by a full TTL window. Operators can revoke earlier.
//
// Idempotent: re-running skips any doc that already has a non-null
// expiresAt. Safe to schedule + re-run.
//
// Required: ADC credentials for the peakops-pilot GCP project, or
// GOOGLE_APPLICATION_CREDENTIALS pointing at a service account.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("/Users/kesserumini/peakops/my-app/functions_clean/node_modules/firebase-admin");
const {
  TOKEN_TTL_DAYS,
} = require("/Users/kesserumini/peakops/my-app/functions_clean/_customerReviewToken");

const PROJECT = process.env.PEAKOPS_PROJECT || "peakops-pilot";
const APPLY = process.argv.includes("--apply");

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const { Timestamp } = admin.firestore;

const TTL_MS_FOR_ACTIVE = TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
const TTL_MS_FOR_TERMINAL = 7 * 24 * 60 * 60 * 1000;

function nowMs() { return Date.now(); }

function dimsForLink(data) {
  const consumed = !!data.consumedAt;
  const revoked = !!data.revokedAt;
  const terminal = consumed || revoked;
  const createdMs = (() => {
    const ts = data.createdAt;
    if (!ts) return null;
    if (typeof ts === "object" && Number.isFinite(Number(ts._seconds))) {
      return Number(ts._seconds) * 1000;
    }
    if (typeof ts.toMillis === "function") {
      try { return ts.toMillis(); } catch (_) { return null; }
    }
    return null;
  })();
  return { consumed, revoked, terminal, createdMs };
}

function plannedExpiresAt({ terminal, createdMs }) {
  if (terminal) {
    const base = Number.isFinite(createdMs) ? createdMs : nowMs();
    return new Date(base + TTL_MS_FOR_TERMINAL);
  }
  return new Date(nowMs() + TTL_MS_FOR_ACTIVE);
}

async function main() {
  console.log(`PEAKOPS_CUSTOMER_REVIEW_TOKEN_TTL_V1 backfill on ${PROJECT}`);
  console.log(`mode: ${APPLY ? "APPLY (writes will land)" : "DRY-RUN (no writes)"}`);
  console.log("");

  const col = db.collection("customer_review_links");
  let pageSize = 200;
  let lastDocId = null;
  let scanned = 0;
  let nullTTL = 0;
  let alreadySet = 0;
  let plannedWrites = [];

  while (true) {
    let q = col.orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
    if (lastDocId) q = q.startAfter(lastDocId);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      scanned++;
      const data = d.data() || {};
      if (data.expiresAt != null) { alreadySet++; continue; }
      const dims = dimsForLink(data);
      const expiresAt = plannedExpiresAt(dims);
      nullTTL++;
      plannedWrites.push({ id: d.id, ref: d.ref, expiresAt, dims });
      // Don't log every doc — print a few representatives.
      if (plannedWrites.length <= 5 || plannedWrites.length % 50 === 0) {
        console.log(
          `  ${d.id.slice(0, 12)}…  terminal=${dims.terminal}  ` +
          `createdMs=${dims.createdMs || "<unknown>"}  → expiresAt=${expiresAt.toISOString()}`,
        );
      }
    }
    lastDocId = snap.docs[snap.docs.length - 1].id;
    if (snap.size < pageSize) break;
  }

  console.log("");
  console.log(`Scan complete.`);
  console.log(`  scanned:        ${scanned}`);
  console.log(`  already_set:    ${alreadySet}`);
  console.log(`  null_ttl:       ${nullTTL}`);
  console.log("");

  if (!APPLY) {
    console.log(`Dry run — no writes performed. Re-run with --apply to execute.`);
    process.exit(0);
  }

  let written = 0;
  // Batched writes; Firestore batch limit is 500.
  for (let i = 0; i < plannedWrites.length; i += 400) {
    const batch = db.batch();
    const slice = plannedWrites.slice(i, i + 400);
    for (const p of slice) {
      batch.set(p.ref, {
        expiresAt: p.expiresAt,
        expiresInDays: TOKEN_TTL_DAYS,
        ttlBackfilledAt: admin.firestore.FieldValue.serverTimestamp(),
        ttlBackfillReason: p.dims.terminal ? "terminal_link" : "legacy_active_link",
      }, { merge: true });
    }
    await batch.commit();
    written += slice.length;
    console.log(`  wrote batch: ${written}/${plannedWrites.length}`);
  }

  console.log("");
  console.log(`Backfill complete. ${written} link doc(s) updated.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Backfill failed:", e?.stack || e?.message || e);
  process.exit(1);
});
