// PEAKOPS_DETERMINISTIC_HASH_AUDIT_V1 (2026-05-19, PR 46)
//
// Audit script: verifies that re-exporting the same incident produces
// an identical originalRecordHash.
//
// Operator workflow:
//   1. Pick a closed incident with packetMeta.originalRecordHash set
//      (i.e., an incident that's been exported at least once post-PR-46).
//   2. node scripts/smoke/repeatExportHashCheck.cjs <orgId> <incidentId>
//        → prints the current originalRecordHash.
//   3. Trigger a re-export of that incident via the Summary UI.
//   4. Run the script again.
//      → prints the new originalRecordHash + a PASS/FAIL comparison
//        against the previously printed value (passed via --expect=<hash>
//        or read from .peakops_hash_audit_<incidentId>.json sidecar).
//
// What "PASS" means: identical originalRecordHash before and after a
// re-export → the original-record/ section is byte-stable → PR 46's
// deterministic-hash contract holds for this incident.
//
// What "FAIL" means: drift between exports. Means either (a) Firestore
// state for the incident changed between exports (legitimate), or (b)
// PR 46's determinism logic has a hole (regression). Inspect packetMeta
// fields + the original-record/ contents of both versions to diagnose.

const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "peakops-pilot" });
const db = admin.firestore();

async function main() {
  const argv = process.argv.slice(2);
  const orgId = argv[0];
  const incidentId = argv[1];
  const expectFlag = argv.find((a) => a.startsWith("--expect="));
  const expectedHash = expectFlag ? expectFlag.slice("--expect=".length) : "";

  if (!orgId || !incidentId) {
    console.error("Usage: node repeatExportHashCheck.cjs <orgId> <incidentId> [--expect=<hash>]");
    process.exit(2);
  }

  const sidecarPath = path.join(
    require("os").tmpdir(),
    `.peakops_hash_audit_${incidentId}.json`
  );

  const inc = (await db.doc(`incidents/${incidentId}`).get()).data() || null;
  if (!inc) {
    console.error(`Incident not found: ${incidentId}`);
    process.exit(2);
  }

  const pm = inc.packetMeta || null;
  if (!pm || !pm.originalRecordHash) {
    console.error(`No packetMeta.originalRecordHash on ${incidentId}.`);
    console.error("Re-export the incident via the UI first so PR 46 can populate it.");
    process.exit(2);
  }

  const currentHash = String(pm.originalRecordHash);
  const supplementalHash = String(pm.supplementalAddendaHash || "(none)");
  const topLevelHash = String(pm.topLevelHash || "(none)");
  const packetVersion = pm.packetVersion || pm.reportRevision || null;
  const exportedAt = pm.exportedAt || null;

  console.log("");
  console.log("PEAKOPS REPEAT-EXPORT HASH AUDIT");
  console.log("─────────────────────────────────");
  console.log(`Incident:            ${incidentId}`);
  console.log(`Org:                 ${orgId}`);
  console.log(`Packet version:      ${packetVersion}`);
  console.log(`Exported at:         ${exportedAt}`);
  console.log(`Original record:     ${currentHash}`);
  console.log(`Supplemental:        ${supplementalHash}`);
  console.log(`Top-level:           ${topLevelHash}`);
  console.log("");

  // Compare against expected hash if provided
  let priorHash = expectedHash;
  if (!priorHash) {
    // Read sidecar from a prior run
    try {
      if (fs.existsSync(sidecarPath)) {
        const raw = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
        priorHash = String(raw.originalRecordHash || "");
      }
    } catch (_) { /* ignore */ }
  }

  // Persist current hash to the sidecar for the NEXT run
  try {
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify(
        {
          incidentId,
          orgId,
          recordedAt: new Date().toISOString(),
          packetVersion,
          exportedAt,
          originalRecordHash: currentHash,
          supplementalAddendaHash: supplementalHash,
          topLevelHash,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`Recorded current hash to sidecar: ${sidecarPath}`);
  } catch (e) {
    console.warn(`Could not write sidecar (${sidecarPath}): ${e.message}`);
  }

  if (priorHash) {
    console.log("");
    console.log(`Prior hash:    ${priorHash}`);
    console.log(`Current hash:  ${currentHash}`);
    if (priorHash === currentHash) {
      console.log("");
      console.log("PASS  originalRecordHash identical between exports.");
      console.log("      The original-record/ section is byte-stable for this incident.");
      process.exit(0);
    } else {
      console.log("");
      console.log("FAIL  originalRecordHash differs between exports.");
      console.log("      Either Firestore state changed between exports (legitimate)");
      console.log("      or PR 46's determinism logic has a regression. Investigate.");
      process.exit(1);
    }
  } else {
    console.log("No prior hash to compare against. Re-export the incident, then");
    console.log("re-run this script to verify byte-stability.");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("ERR", e && e.message);
  process.exit(1);
});
