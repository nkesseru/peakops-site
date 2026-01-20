#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

ORG_ID="${ORG_ID:-org_001}"
INCIDENT_ID="${INCIDENT_ID:-inc_TEST}"

echo "==> Seed Timeline v1"
echo "    orgId=$ORG_ID"
echo "    incidentId=$INCIDENT_ID"

node <<'NODE'
const admin = require("firebase-admin");
const crypto = require("crypto");

if (!admin.apps.length) admin.initializeApp({ projectId: "peakops-pilot" });
const db = admin.firestore();

function isoNow() { return new Date().toISOString(); }
function sha256(x) { return crypto.createHash("sha256").update(x).digest("hex"); }

(async () => {
  const orgId = process.env.ORG_ID || "org_001";
  const incidentId = process.env.INCIDENT_ID || "inc_TEST";

  const incRef = db.collection("incidents").doc(incidentId);
  const incSnap = await incRef.get();
  if (!incSnap.exists) {
    throw new Error(`Incident not found: ${incidentId} (seed incident first)`);
  }

  const nowIso = isoNow();
  const base = incSnap.data() || {};
  const startTime = base.startTime || base.createdAt || nowIso;

  // deterministic doc IDs so reruns merge instead of duplicating
  const events = [
    {
      id: "ev_001_incident_created",
      type: "INCIDENT_CREATED",
      occurredAt: startTime,
      title: "Incident created",
      message: "Baseline incident created (seed)",
      source: "SYSTEM",
      links: { incidentId },
    },
    {
      id: "ev_002_intake_validated",
      type: "INTAKE_VALIDATED",
      occurredAt: nowIso,
      title: "Intake validated",
      message: "Baseline fields confirmed",
      source: "SYSTEM",
      links: { incidentId },
    },
    {
      id: "ev_003_timeline_generated",
      type: "TIMELINE_GENERATED",
      occurredAt: nowIso,
      title: "Timeline generated",
      message: "TimelineEvents created + timelineMeta set",
      source: "SYSTEM",
      links: { incidentId },
    },
  ].map(e => ({
    ...e,
    orgId,
    incidentId,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));

  // timelineHash should change if event content changes
  const hashInput = JSON.stringify(events.map(e => ({
    id: e.id, type: e.type, occurredAt: e.occurredAt, title: e.title, message: e.message
  })));
  const timelineHash = sha256(hashInput);

  const batch = db.batch();
  const tlCol = incRef.collection("timelineEvents");

  for (const ev of events) {
    batch.set(tlCol.doc(ev.id), ev, { merge: true });
  }

  batch.set(incRef, {
    timelineMeta: {
      algo: "SHA256",
      timelineHash,
      generatedAt: nowIso,
      eventCount: events.length,
      source: "seed",
    },
    updatedAt: nowIso,
  }, { merge: true });

  await batch.commit();

  console.log("✅ timelineEvents upserted:", events.length);
  console.log("✅ timelineMeta set:", timelineHash);
})();
NODE

echo "==> Smoke: fetch timelineEvents via Next proxy"
curl -fsS "http://127.0.0.1:3000/api/fn/getTimelineEvents?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 260; echo

echo
echo "OPEN:"
echo "  http://127.0.0.1:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
