#!/usr/bin/env node
/**
 * Deterministic org seeder for Firestore EMULATOR (Admin SDK).
 *
 * Requires:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085
 */

import admin from "firebase-admin";
import fs from "node:fs";

function resolveProjectId() {
  return (
    process.env.GCLOUD_PROJECT ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.PROJECT_ID ||
    "peakops-pilot"
  );
}

function resolveFirestoreEmulatorHost() {
  const fromEnv = String(process.env.FIRESTORE_EMULATOR_HOST || "").trim();
  if (fromEnv) return fromEnv;

  try {
    const raw = fs.readFileSync("firebase.json", "utf8");
    const cfg = JSON.parse(raw);
    const fsCfg = cfg?.emulators?.firestore || {};
    const host = String(fsCfg.host || "").trim();
    const port = Number(fsCfg.port || 0);
    if (host && Number.isFinite(port) && port > 0) return `${host}:${port}`;
  } catch {}

  console.error("❌ Missing FIRESTORE_EMULATOR_HOST and could not resolve from firebase.json");
  console.error("   Set FIRESTORE_EMULATOR_HOST manually, e.g. FIRESTORE_EMULATOR_HOST=127.0.0.1:8085");
  process.exit(1);
}

async function preflightEmulator(host, projectId) {
  const probeHost = String(host || "").startsWith("127.0.0.1")
    ? String(host).replace(/^127\.0\.0\.1(?=:|$)/, "localhost")
    : String(host || "");
  const url = `http://${probeHost}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/orgs?pageSize=1`;

  let raw = "";
  try {
    const res = await fetch(url, { method: "GET" });
    raw = await res.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.error || !res.ok) {
      console.error("❌ Firestore emulator preflight failed");
      console.error(`   FIRESTORE_EMULATOR_HOST=${host}`);
      console.error(`   PROJECT_ID=${projectId}`);
      console.error(`   response=${String(raw || "").slice(0, 300)}`);
      process.exit(1);
    }
  } catch (err) {
    console.error("❌ Firestore emulator preflight failed");
    console.error(`   FIRESTORE_EMULATOR_HOST=${host}`);
    console.error(`   PROJECT_ID=${projectId}`);
    console.error(`   response=${String(raw || err?.message || err || "").slice(0, 300)}`);
    process.exit(1);
  }
}

async function main() {
  const host = resolveFirestoreEmulatorHost();
  process.env.FIRESTORE_EMULATOR_HOST = host;

  const projectId = resolveProjectId();
  console.log(`   using FIRESTORE_EMULATOR_HOST=${host}`);
  await preflightEmulator(host, projectId);

  if (!admin.apps.length) {
    admin.initializeApp({ projectId });
  }

  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  const orgs = [
    {
      id: "riverbend-electric",
      data: {
        orgId: "riverbend-electric",
        name: "Riverbend Electric",
        displayName: "Riverbend Electric",
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      id: "northgrid-services",
      data: {
        orgId: "northgrid-services",
        name: "Northgrid Services",
        displayName: "Northgrid Services",
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      id: "metro-lineworks",
      data: {
        orgId: "metro-lineworks",
        name: "Metro Lineworks",
        displayName: "Metro Lineworks",
        createdAt: now,
        updatedAt: now,
      },
    },
  ];

  console.log(`🧪 Seeding org directory into emulator for projectId="${projectId}"`);
  console.log(`   FIRESTORE_EMULATOR_HOST=${process.env.FIRESTORE_EMULATOR_HOST}`);

  const batch = db.batch();
  for (const org of orgs) {
    const ref = db.collection("orgs").doc(org.id);
    batch.set(ref, org.data, { merge: true });
  }

  await batch.commit();

  console.log("✅ Seeded orgs:");
  for (const org of orgs) {
    console.log(`   - orgs/${org.id}`);
  }
}

main().catch((err) => {
  console.error("❌ seed_orgs_demo failed:", err);
  process.exit(1);
});
