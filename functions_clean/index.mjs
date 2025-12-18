import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { sha256OfObject } from "./audit.mjs";

if (!getApps().length) initializeApp();

export const hello = onRequest((req, res) => {
  res.json({ ok: true, msg: "hello from functions_clean" });
});

export const generateFilingPackageAndPersist = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const incidentId = body.incidentId;
    const orgId = body.orgId;
    const draftsByType = (body.draftsByType && typeof body.draftsByType === "object") ? body.draftsByType : null;

    if (!incidentId || !orgId) {
      return res.status(400).json({ ok: false, error: "Missing incidentId/orgId", gotKeys: Object.keys(body) });
    }
    if (!draftsByType) {
      return res.status(400).json({ ok: false, error: "Missing draftsByType", gotKeys: Object.keys(body) });
    }

    const filingTypes = Object.keys(draftsByType);
    if (filingTypes.length === 0) {
      return res.status(400).json({ ok: false, error: "draftsByType is empty" });
    }

    const compliance = body.compliance ?? null;
    const generatorVersion = body.generatorVersion ?? "v1";

    // Hash compliance once (shared across all filing docs)
    const complianceHash = compliance ? sha256OfObject(compliance).hash : null;

    const db = getFirestore();
    const now = new Date().toISOString();
    const batch = db.batch();

    for (const type of filingTypes) {
      const draft = draftsByType[type] ?? {};
      const payload = draft.payload ?? {};
      const payloadHash = sha256OfObject(payload).hash;

      const ref = db.collection("incidents").doc(incidentId).collection("filings").doc(type);

      batch.set(ref, {
        id: type,
        orgId,
        incidentId,
        type,

        status: "DRAFT",

        payload,
        payloadHash: payloadHash ? { algo: "SHA256", value: payloadHash } : null,

        complianceSnapshot: compliance,
        complianceHash: complianceHash ? { algo: "SHA256", value: complianceHash } : null,

        generatedAt: draft.generatedAt ?? now,
        generatorVersion,

        createdAt: now,
        updatedAt: now,
        createdBy: "system",
      }, { merge: true });
    }

    const logRef = db.collection("system_logs").doc();
    batch.set(logRef, {
      orgId,
      incidentId,
      level: "INFO",
      event: "filing.package.persisted",
      message: "Persisted filing drafts + hashes (Step 2.8)",
      context: {
        filingTypes,
        generatorVersion,
        complianceOk: compliance?.ok ?? null,
        complianceHash,
      },
      actor: { type: "SYSTEM" },
      createdAt: now,
    });

    await batch.commit();
    return res.json({ ok: true, persisted: filingTypes, systemLogId: logRef.id, complianceHash });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

import { generateTimelineLevel1 } from "./timeline.mjs";

export const generateTimelineAndPersist = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const incidentId = body.incidentId;
    const orgId = body.orgId;

    if (!incidentId || !orgId) {
      return res.status(400).json({ ok: false, error: "Missing incidentId/orgId", gotKeys: Object.keys(body) });
    }

    const db = getFirestore();
    const now = new Date().toISOString();

    // 1) Load incident
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    if (!incSnap.exists) return res.status(404).json({ ok: false, error: "Incident not found" });

    const inc = incSnap.data() || {};
    const incident = {
      id: incidentId,
      orgId,
      title: inc.title || "(untitled)",
      startTime: inc.startTime || inc.createdAt || now,
      detectedTime: inc.detectedTime || null,
      resolvedTime: inc.resolvedTime || null,
    };

    // 2) Load filings subcollection
    const filingsSnap = await incRef.collection("filings").get();
    const filings = filingsSnap.docs.map(d => {
      const x = d.data() || {};
      return {
        id: d.id,
        type: x.type || d.id,
        status: x.status || "UNKNOWN",
        generatedAt: x.generatedAt || null,
        createdAt: x.createdAt || null,
        updatedAt: x.updatedAt || null,
      };
    });

    // 3) Load system logs for this incident (limit to recent 200)
    const logsSnap = await db.collection("system_logs")
      .where("incidentId", "==", incidentId)
      .orderBy("createdAt", "desc")
      .limit(200)
      .get();

    const systemLogs = logsSnap.docs.map(d => {
      const x = d.data() || {};
      return {
        id: d.id,
        event: x.event || "",
        message: x.message || "",
        createdAt: x.createdAt || now,
      };
    }).reverse(); // oldest -> newest

    // 4) Generate timeline + hash
    const { events, timelineHash, generatedAt } = generateTimelineLevel1({ incident, filings, systemLogs });

    // 5) Persist events (batch). (Safe under 500; if you exceed later, we chunk.)
    const batch = db.batch();
    const tlCol = incRef.collection("timelineEvents");

    for (const ev of events) {
      batch.set(tlCol.doc(ev.id), ev, { merge: true });
    }

    // 6) Persist timeline meta + hash on incident
    batch.set(incRef, {
      timelineMeta: {
        algo: "SHA256",
        timelineHash,
        generatedAt,
        eventCount: events.length,
        source: "system",
      },
      updatedAt: now,
    }, { merge: true });

    // 7) System log entry
    const logRef = db.collection("system_logs").doc();
    batch.set(logRef, {
      orgId,
      incidentId,
      level: "INFO",
      event: "timeline.generated",
      message: "Generated and persisted timelineEvents + timelineHash (Step 3C/3D)",
      context: { eventCount: events.length, timelineHash },
      actor: { type: "SYSTEM" },
      createdAt: now,
    });

    await batch.commit();

    return res.json({ ok: true, incidentId, eventCount: events.length, timelineHash, generatedAt, systemLogId: logRef.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});
