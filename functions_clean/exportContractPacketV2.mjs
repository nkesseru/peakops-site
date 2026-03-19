import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { Storage } from "@google-cloud/storage";
import crypto from "crypto";
import { exportContractPacketV1Core } from "./exportContractPacketV1.mjs"; // expects you to expose a core builder

if (!getApps().length) initializeApp();

const storage = new Storage();
const BUCKET = process.env.CONTRACT_PACKET_BUCKET || "peakops-contract-packets";

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function exportContractPacketV2(req, res) {
  try {
    res.set("Access-Control-Allow-Origin", "*");

    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();
    const versionId = String(req.query.versionId || "v1").trim();
    const limit = Number(req.query.limit || 200);

    if (!orgId || !contractId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/contractId" });
    }

    // Build packet using existing core builder (NO storage)
    const out = await exportContractPacketV1Core({ orgId, contractId, versionId, limit });

    // out must include: zipBuffer, packetHash, filename, sizeBytes, count, manifest
    const zipBuf = out.zipBuffer;
    const packetHash = out.packetHash || sha256(zipBuf);
    const filename = out.filename || `peakops_contractpacket_${contractId}_${packetHash.slice(0,8)}.zip`;

    const objectPath =
      `contract-packets/${orgId}/${contractId}/${new Date().toISOString().replace(/[:.]/g,"-")}_${packetHash.slice(0,8)}.zip`;

    // Upload to GCS
    const file = storage.bucket(BUCKET).file(objectPath);
    await file.save(zipBuf, {
      resumable: false,
      contentType: "application/zip",
      metadata: {
        metadata: { orgId, contractId, versionId, packetHash }
      }
    });

    // Signed URL (1 hour) – adjust as desired
    const [downloadUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 60 * 60 * 1000
    });

    // Write Firestore record
    const db = getFirestore();
    const packetDoc = {
      orgId,
      contractId,
      versionId,
      packetHash,
      sizeBytes: zipBuf.length,
      bucket: BUCKET,
      objectPath,
      filename,
      createdAt: Timestamp.now()
    };

    const ref = db.collection("contract_packets").doc();
    await ref.set(packetDoc);

    return res.json({
      ok: true,
      orgId,
      contractId,
      versionId,
      count: out.count ?? null,
      packetHash,
      sizeBytes: zipBuf.length,
      filename,
      bucket: BUCKET,
      objectPath,
      downloadUrl,
      packetId: ref.id
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
