import { getFirestore, Timestamp } from "firebase-admin/firestore";
import JSZip from "jszip";
import crypto from "crypto";

// ---- deterministic JSON helpers ----
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
function stableStringify(obj) {
  return JSON.stringify(stableSortKeys(obj), null, 2);
}
function sha256Hex(bufOrStr) {
  const b = (typeof bufOrStr === "string") ? Buffer.from(bufOrStr, "utf8") : Buffer.from(bufOrStr);
  return crypto.createHash("sha256").update(b).digest("hex");
}
function nowIso() { return new Date().toISOString(); }

// ---- preflight: block export when core artifacts are missing ----
function exportPreflight({ incident, filings, timelineMeta, evidenceCount }) {
  const blockers = [];
  const warnings = [];

  if (!incident) blockers.push("BLOCK: Incident missing.");
  if (!timelineMeta) blockers.push("BLOCK: Timeline not generated yet.");
  if (!filings || filings.length === 0) blockers.push("BLOCK: No filings generated yet.");

  const req = Array.isArray(incident?.filingTypesRequired) ? incident.filingTypesRequired : [];
  const have = new Set((filings || []).map(f => String(f.type || f.id || "")));

  for (const t of req) {
    if (!have.has(String(t))) blockers.push(`BLOCK: Missing filing: ${t}`);
  }

  // filing status warnings
  for (const f of (filings || [])) {
    const t = String(f.type || f.id || "UNKNOWN");
    const st = String(f.status || "DRAFT").toUpperCase();
    if (st === "DRAFT") warnings.push(`WARN: ${t} is still DRAFT`);
    if (st === "READY") warnings.push(`WARN: ${t} is READY but not submitted`);
    if (st === "CANCELLED") warnings.push(`WARN: ${t} is CANCELLED`);
    if (st === "SUBMITTED") {
      const cid = f?.external?.confirmationId || f?.confirmationId || null;
      if (!cid) blockers.push(`BLOCK: ${t} is SUBMITTED but missing confirmationId`);
    }
  }

  // evidence is optional for now, but we warn if none
  if (!evidenceCount || evidenceCount <= 0) warnings.push("WARN: Evidence locker is empty (0 items).");

  return { blockers, warnings, okToExport: blockers.length === 0 };
}

// ---- readers ----
async function readIncident(db, incidentId) {
  const snap = await db.collection("incidents").doc(incidentId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function readFilings(db, incidentId) {
  const ref = db.collection("incidents").doc(incidentId).collection("filings");
  const qs = await ref.get().catch(() => null);
  if (qs && qs.docs) return qs.docs.map(d => ({ id: d.id, ...d.data() }));
  return [];
}

async function readTimelineEvents(db, incidentId, limit = 500) {
  const ref = db.collection("incidents").doc(incidentId).collection("timelineEvents");
  const qs = await ref.orderBy("occurredAt", "asc").limit(Math.min(Number(limit || 500), 5000)).get().catch(() => null);
  if (qs && qs.docs) return qs.docs.map(d => ({ id: d.id, ...d.data() }));
  return [];
}

async function readEvidenceLocker(db, incidentId, limit = 500) {
  const ref = db.collection("incidents").doc(incidentId).collection("evidence_locker");
  const qs = await ref.orderBy("storedAt", "desc").limit(Math.min(Number(limit || 500), 5000)).get().catch(() => null);
  if (qs && qs.docs) return qs.docs.map(d => ({ id: d.id, ...d.data() }));
  return [];
}

async function readLogs(db, incidentId, limit = 200) {
  const [sysSnap, userSnap, filingSnap] = await Promise.all([
    db.collection("system_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(limit).get().catch(()=>null),
    db.collection("user_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(limit).get().catch(()=>null),
    db.collection("filing_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(limit).get().catch(()=>null),
  ]);

  const toList = (snap) => snap ? snap.docs.map(d => ({ id:d.id, ...d.data() })) : [];
  return {
    system: toList(sysSnap),
    user: toList(userSnap),
    filing: toList(filingSnap),
  };
}

async function readSubmitQueue(db, orgId, incidentId, limit = 200) {
  const qs = await db.collection("submit_queue")
    .where("orgId","==",orgId)
    .where("incidentId","==",incidentId)
    .orderBy("createdAt","desc")
    .limit(limit)
    .get()
    .catch(() => null);
  return qs ? qs.docs.map(d => ({ id:d.id, ...d.data() })) : [];
}

// ---- writer: system log + packet record ----
async function writeSystemLog(db, payload) {
  await db.collection("system_logs").add({
    ...payload,
    createdAt: payload.createdAt || nowIso(),
    level: payload.level || "INFO",
    source: payload.source || "system",
  });
}

async function writeRegPacketRecord(db, payload) {
  const ref = db.collection("reg_packets").doc();
  await ref.set({
    id: ref.id,
    ...payload,
    createdAt: payload.createdAt || nowIso(),
  }, { merge: true });
  return ref.id;
}

// ---- main core: builds deterministic ZIP ----
export async function exportRegPacketV1Core(db, {
  orgId,
  incidentId,
  purpose = "REGULATORY",
  requestedBy = "admin_ui",
  limitTimeline = 500,
  limitEvidence = 500,
} = {}) {
  if (!orgId || !incidentId) {
    return { ok:false, error:"orgId and incidentId are required" };
  }

  const incident = await readIncident(db, incidentId);
  if (!incident) return { ok:false, error:"Incident not found" };

  const [filings, timelineEvents, evidenceDocs, logs, submitQueue] = await Promise.all([
    readFilings(db, incidentId),
    readTimelineEvents(db, incidentId, limitTimeline),
    readEvidenceLocker(db, incidentId, limitEvidence),
    readLogs(db, incidentId, 200),
    readSubmitQueue(db, orgId, incidentId, 200),
  ]);

  const timelineMeta = incident.timelineMeta || null;
  const filingsMeta = incident.filingsMeta || null;

  const preflight = exportPreflight({
    incident,
    filings,
    timelineMeta,
    evidenceCount: evidenceDocs.length
  });

  // Always record attempt (blocked or ok)
  await writeSystemLog(db, {
    orgId, incidentId,
    event: preflight.okToExport ? "regpacket.export.attempt" : "regpacket.export.blocked",
    message: preflight.okToExport ? "Reg packet export attempt" : "Reg packet export blocked",
    context: { purpose, requestedBy, ...preflight },
    actor: { type:"SYSTEM" },
  });

  if (!preflight.okToExport) {
    return { ok:false, ...preflight };
  }

  // Build deterministic content
  const generatedAt = nowIso();
  const summary = {
    orgId,
    incidentId,
    title: incident.title || incidentId,
    status: incident.status || "ACTIVE",
    purpose: String(purpose || "REGULATORY").toUpperCase(),
    generatedAt,
    filingsMeta,
    timelineMeta,
    counts: {
      filings: filings.length,
      timelineEvents: timelineEvents.length,
      evidence: evidenceDocs.length,
      systemLogs: logs.system.length,
      userLogs: logs.user.length,
      filingLogs: logs.filing.length,
      submitQueue: submitQueue.length,
    }
  };

  const zip = new JSZip();
  const hashes = {};

  function addFile(path, obj) {
    const content = stableStringify(obj);
    hashes[path] = sha256Hex(content);
    zip.file(path, content);
  }

  // Core files
  addFile("incident/summary.json", summary);
  addFile("incident/incident.json", incident);

  addFile("filings/filings.json", filings);
  addFile("filings/filings_meta.json", filingsMeta || {});

  addFile("timeline/timeline_meta.json", timelineMeta || {});
  addFile("timeline/timeline_events.json", { events: timelineEvents });

  addFile("evidence/evidence_locker.json", evidenceDocs);

  addFile("logs/system_logs.json", logs.system);
  addFile("logs/user_logs.json", logs.user);
  addFile("logs/filing_action_logs.json", logs.filing);

  addFile("submit_queue/jobs.json", submitQueue);

  // Manifest + packet hash
  const manifest = {
    version: "regpacket.v1",
    generatedAt,
    orgId,
    incidentId,
    purpose: summary.purpose,
    fileCount: Object.keys(hashes).length,
    hashes,
  };

  const manifestStr = stableStringify(manifest);
  const packetHash = sha256Hex(manifestStr);

  zip.file("manifest.json", manifestStr);
  zip.file("packet_hash.txt", packetHash);

  const readme = [
    "PeakOps Regulatory Packet (V1)",
    "",
    `orgId: ${orgId}`,
    `incidentId: ${incidentId}`,
    `purpose: ${summary.purpose}`,
    `generatedAt: ${generatedAt}`,
    `packetHash: ${packetHash}`,
    "",
    "How to use:",
    "1) This ZIP is deterministic: all JSON is stable-sorted and hashed.",
    "2) Verify integrity:",
    "   - Compare packet_hash.txt to manifest.json hash map.",
    "   - Each file hash in manifest.json should match sha256(file contents).",
    "3) Primary artifacts:",
    "   - incident/incident.json",
    "   - filings/filings.json",
    "   - timeline/timeline_events.json",
    "   - evidence/evidence_locker.json",
    "",
  ].join("\n");
  zip.file("README.txt", readme);

  const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const zipBase64 = zipBuf.toString("base64");

  const filename = `peakops_regpacket_${incidentId}_${orgId}_${generatedAt.replace(/[:.]/g,"-")}_${summary.purpose}_${packetHash.slice(0,8)}.zip`;

  const regPacketId = await writeRegPacketRecord(db, {
    orgId, incidentId, purpose: summary.purpose, requestedBy,
    packetHash,
    sizeBytes: zipBuf.length,
    counts: summary.counts,
    filename,
  });

  return {
    ok: true,
    orgId,
    incidentId,
    purpose: summary.purpose,
    generatedAt,
    packetHash,
    sizeBytes: zipBuf.length,
    filename,
    zipBase64,
    regPacketId,
    ...preflight,
  };
}

// Convenience handler (functions_clean/index.mjs will call this)
export async function exportRegPacketV1Handler(req) {
  const orgId = String(req.query.orgId || req.body?.orgId || "");
  const incidentId = String(req.query.incidentId || req.body?.incidentId || "");
  const purpose = String(req.query.purpose || req.body?.purpose || "REGULATORY");
  const requestedBy = String(req.query.requestedBy || req.body?.requestedBy || "admin_ui");

  const db = getFirestore();
  return exportRegPacketV1Core(db, { orgId, incidentId, purpose, requestedBy });
}
