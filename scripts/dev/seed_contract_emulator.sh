#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

export FIRESTORE_EMULATOR_HOST="127.0.0.1:8081"
export GCLOUD_PROJECT="peakops-pilot"

ORG_ID="${1:-org_001}"
CONTRACT_ID="${2:-car_abc123}"
CUSTOMER_ID="${3:-cust_acme_001}"

node - <<'NODE'
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();

const orgId = process.env.ORG_ID || "org_001";
const contractId = process.env.CONTRACT_ID || "car_abc123";
const customerId = process.env.CUSTOMER_ID || "cust_acme_001";

await db.collection("contracts").doc(contractId).set({
  orgId,
  contractNumber: "CTR-2025-0001",
  status: "ACTIVE",
  type: "MSA",
  customerId,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}, { merge: true });

console.log("✅ seeded emulator: contracts/" + contractId);
NODE
