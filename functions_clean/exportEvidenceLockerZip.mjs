import JSZip from "jszip";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

function mustStr(v, name) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing ${name}`);
  return v.trim();
}

function safeName(s) {
  return String(s || "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

export async function handleExportEvidenceLockerZipRequest(req, res) {
  try {
    const orgId = mustStr(req.query.orgId, "orgId");
    const incidentId = mustStr(req.query.incidentId, "incidentId");
    const limit = Math.max(1, Math.min(Number(req.query.limit || 200), 1000));

    const db = getFirestore();

    const col = db.collection("incidents").doc(incidentId).collection("evidence_locker");
    const snap = await col.orderBy("storedAt", "desc").limit(limit).get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!docs.length) {
      return res.json({ ok: false, error: "NO_EVIDENCE", count: 0 });
    }

    const zip = new JSZip();

    // evidence/evidence.json
    zip.folder("evidence").file("evidence.json", JSON.stringify(docs, null, 2));

    // hashes.json (id -> sha256)
    const hashes = {};
    for (const d of docs) hashes[d.id] = d?.hash?.value || "";
    zip.file("hashes.json", JSON.stringify(hashes, null, 2));

    // incident/incident.json (lightweight)
    const incSnap = await db.collection("incidents").doc(incidentId).get();
    const incident = incSnap.exists ? incSnap.data() : { incidentId, orgId };
    zip.folder("incident").file("incident.json", JSON.stringify(incident, null, 2));

    // README
    zip.file(
      "README.txt",
      [
        "PeakOps Evidence Packet",
        `orgId: ${orgId}`,
        `incidentId: ${incidentId}`,
        `count: ${docs.length}`,
        "",
        "Contents:",
        "- evidence/evidence.json (all evidence locker docs)",
        "- hashes.json (docId -> sha256)",
        "- incident/incident.json (incident snapshot)",
        "",
      ].join("\n")
    );

    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const zipBase64 = buf.toString("base64");

    const iso = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `peakops_evidence_inc_${safeName(incidentId)}_${safeName(orgId)}_${iso}_${safeName((docs[0]?.hash?.value || "").slice(0, 8))}.zip`;

    return res.json({
      ok: true,
      orgId,
      incidentId,
      count: docs.length,
      sizeBytes: buf.length,
      filename,
      zipBase64,
      generatedAt: Timestamp.now(),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
}


// Minimal core stub (unblock). Replace with real implementation.
export async function exportEvidenceLockerZipCore(_db, { orgId, incidentId, limit=200 } = {}) {
  return { ok:false, error:'NO_EVIDENCE', orgId, incidentId, count:0 };
}
