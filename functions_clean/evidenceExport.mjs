import JSZip from "jszip";
import crypto from "crypto";

function stableSortKeys(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stableSortKeys);
  if (typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = stableSortKeys(obj[k]);
    return out;
  }
  return obj;
}
function stableStringify(obj) { return JSON.stringify(stableSortKeys(obj), null, 2); }
function sha256Hex(bufOrStr) {
  const b = (typeof bufOrStr === "string") ? Buffer.from(bufOrStr, "utf8") : Buffer.from(bufOrStr);
  return crypto.createHash("sha256").update(b).digest("hex");
}

export async function handleExportEvidenceLockerZip(req, res) {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    const limit = Math.min(Number(req.query.limit || 200), 500);

    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    const db = req.__db; // injected by index.mjs (see patch below)
    if (!db) return res.status(500).json({ ok: false, error: "DB_NOT_INJECTED" });

    // Read incident (nice-to-have)
    const incSnap = await db.collection("incidents").doc(incidentId).get();
    const incident = incSnap.exists ? { id: incSnap.id, ...incSnap.data() } : null;

    // Read evidence docs
    const evSnap = await db.collection("incidents").doc(incidentId)
      .collection("evidence_locker")
      .orderBy("storedAt", "desc")
      .limit(limit)
      .get();

    const evidence = evSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

    if (!evidence.length) {
      return res.status(200).json({ ok: false, error: "NO_EVIDENCE", count: 0 });
    }

    // Build manifest (one row per evidence doc)
    const manifest = evidence.map(e => ({
      id: e.id,
      kind: e.kind || "",
      filingType: e.filingType || "",
      jobId: e.jobId || "",
      storedAt: e.storedAt || null,
      payloadBytes: e.payloadBytes || null,
      payloadTruncated: !!e.payloadTruncated,
      hash: e.hash || null,
    }));

    const zip = new JSZip();
    const hashes = {};
    const addFile = (path, contentStr) => {
      zip.file(path, contentStr);
      hashes[path] = sha256Hex(contentStr);
    };

    const evidenceJson = stableStringify(evidence);
    const manifestJson = stableStringify(manifest);
    const incidentJson = stableStringify(incident || { missing: true, incidentId });

    addFile("evidence/evidence.json", evidenceJson);
    addFile("evidence/manifest.json", manifestJson);
    addFile("incident/incident.json", incidentJson);

    const hashesJson = stableStringify(hashes);
    addFile("hashes.json", hashesJson);

    const packetHash = sha256Hex(hashesJson);
    const readme = [
      "PeakOps Evidence Locker Packet (V1)",
      `orgId: ${orgId}`,
      `incidentId: ${incidentId}`,
      `count: ${evidence.length}`,
      `packetHash: ${packetHash}`,
      "",
      "Contents:",
      "- evidence/evidence.json (full evidence docs as exported)",
      "- evidence/manifest.json (digest + index for auditors)",
      "- incident/incident.json (incident snapshot)",
      "- hashes.json (per-file SHA256 checksums)",
      "",
      "Notes:",
      "- This packet is deterministic: stable-sorted JSON + hashes.",
      "- packetHash is SHA256(hashes.json).",
    ].join("\n");
    addFile("README.txt", readme);

    const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const zipB64 = zipBuf.toString("base64");

    const filename = `peakops_evidence_${incidentId}_${orgId}_${new Date().toISOString().replace(/[:.]/g,"-")}_${packetHash.slice(0,8)}.zip`;

    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      count: evidence.length,
      packetHash,
      sizeBytes: zipBuf.length,
      filename,
      zipBase64: zipB64,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
