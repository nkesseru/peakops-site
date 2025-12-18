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
    }).reverse(); 

    const [userSnap, filingSnap] = await Promise.all([
      db.collection("user_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(200).get(),
      db.collection("filing_action_logs").where("incidentId","==",incidentId).orderBy("createdAt","desc").limit(200).get(),
    ]);

    const userLogs = userSnap.docs.map(d => ({ id: d.id, ...((d.data())||{}) })).reverse();
    const filingLogs = filingSnap.docs.map(d => ({ id: d.id, ...((d.data())||{}) })).reverse();
// oldest -> newest

    // 4) Generate timeline + hash
    const { events, timelineHash, generatedAt } = generateTimelineLevel1({ incident, filings, systemLogs, userLogs, filingLogs });

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

import { nowIso, requireStr } from "./logging.mjs";

// USER ACTION LOG
export const logUserAction = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const orgId = requireStr(body.orgId, "orgId");
    const incidentId = body.incidentId ? requireStr(body.incidentId, "incidentId") : null;
    const userId = requireStr(body.userId, "userId");
    const action = requireStr(body.action, "action"); // e.g. "incident.viewed"
    const message = typeof body.message === "string" ? body.message : "";
    const context = (body.context && typeof body.context === "object") ? body.context : {};

    const db = getFirestore();
    const createdAt = nowIso();

    const ref = db.collection("user_action_logs").doc();
    await ref.set({
      orgId,
      incidentId,
      userId,
      action,
      message,
      context,
      createdAt,
    });

    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
});

// FILING ACTION LOG
export const logFilingAction = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const orgId = requireStr(body.orgId, "orgId");
    const incidentId = requireStr(body.incidentId, "incidentId");
    const filingType = requireStr(body.filingType, "filingType"); // "DIRS" etc
    const userId = body.userId ? requireStr(body.userId, "userId") : "system";
    const action = requireStr(body.action, "action"); // "submitted" | "amended" | "accepted" | "rejected" | "status_changed"
    const message = typeof body.message === "string" ? body.message : "";
    const context = (body.context && typeof body.context === "object") ? body.context : {};

    const db = getFirestore();
    const createdAt = nowIso();

    const ref = db.collection("filing_action_logs").doc();
    await ref.set({
      orgId,
      incidentId,
      filingType,
      userId,
      action,
      message,
      context,
      createdAt,
    });

    return res.json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
});

// ADMIN VIEWER: fetch recent logs for an incident
export const getIncidentLogs = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET" });

    const incidentId = req.query.incidentId;
    const orgId = req.query.orgId;
    if (typeof incidentId !== "string" || typeof orgId !== "string") {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId query params" });
    }

    const db = getFirestore();

    const [sysSnap, userSnap, filingSnap] = await Promise.all([
      db.collection("system_logs").where("incidentId", "==", incidentId).orderBy("createdAt", "desc").limit(50).get(),
      db.collection("user_action_logs").where("incidentId", "==", incidentId).orderBy("createdAt", "desc").limit(50).get(),
      db.collection("filing_action_logs").where("incidentId", "==", incidentId).orderBy("createdAt", "desc").limit(50).get(),
    ]);

    const toList = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({
      ok: true,
      incidentId,
      orgId,
      system: toList(sysSnap),
      user: toList(userSnap),
      filing: toList(filingSnap),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
});

// TEMP ADMIN HELPER (REMOVE BEFORE PROD)
export const setUserRole = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const uid = body.uid;
    const orgId = body.orgId;
    const role = body.role;

    if (!uid || !orgId || !role) return res.status(400).json({ ok:false, error:"Need uid, orgId, role" });

    const db = getFirestore();
    await db.collection("users").doc(uid).set({
      orgRoles: { [orgId]: role },
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }, { merge: true });

    return res.json({ ok:true, uid, orgId, role });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

import { nowIso, requireStr, optionalStr, pick } from "./api.mjs";

// CREATE INCIDENT (canonical entrypoint)
export const createIncident = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const orgId = requireStr(body.orgId, "orgId");
    const title = requireStr(body.title, "title");
    const startTime = optionalStr(body.startTime) || nowIso();

    const incidentId = optionalStr(body.incidentId) || `inc_${Math.random().toString(36).slice(2, 10)}`;
    const createdAt = nowIso();

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId);

    await ref.set({
      id: incidentId,
      orgId,
      title,
      description: optionalStr(body.description) || "",
      status: body.status || "ACTIVE",
      startTime,
      detectedTime: optionalStr(body.detectedTime),
      resolvedTime: optionalStr(body.resolvedTime),
      location: (body.location && typeof body.location === "object") ? body.location : null,
      affectedCustomers: (typeof body.affectedCustomers === "number") ? body.affectedCustomers : null,
      filingTypesRequired: Array.isArray(body.filingTypesRequired) ? body.filingTypesRequired : ["DIRS","OE_417"],
      createdAt,
      updatedAt: createdAt,
      createdBy: body.createdBy || "system",
    }, { merge: true });

    // system log
    await getFirestore().collection("system_logs").doc().set({
      orgId,
      incidentId,
      level: "INFO",
      event: "incident.created",
      message: "Incident created via API",
      context: { title },
      actor: { type: "SYSTEM" },
      createdAt
    });

    return res.json({ ok: true, incidentId });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
});

// UPDATE INCIDENT (safe patch)
export const updateIncident = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const incidentId = requireStr(body.incidentId, "incidentId");
    const orgId = requireStr(body.orgId, "orgId");

    const db = getFirestore();
    const ref = db.collection("incidents").doc(incidentId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    const patch = pick(body, [
      "title","description","status","detectedTime","resolvedTime","location","affectedCustomers","filingTypesRequired"
    ]);
    patch.updatedAt = nowIso();

    await ref.set(patch, { merge: true });

    await db.collection("system_logs").doc().set({
      orgId,
      incidentId,
      level: "INFO",
      event: "incident.updated",
      message: "Incident updated via API",
      context: { changedKeys: Object.keys(patch) },
      actor: { type: "SYSTEM" },
      createdAt: patch.updatedAt
    });

    return res.json({ ok:true, incidentId });
  } catch (e) {
    return res.status(400).json({ ok:false, error: String(e) });
  }
});

// GET INCIDENT (for UI)
export const getIncident = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const incidentId = req.query.incidentId;
    if (typeof incidentId !== "string") return res.status(400).json({ ok:false, error:"Missing incidentId" });

    const db = getFirestore();
    const snap = await db.collection("incidents").doc(incidentId).get();
    if (!snap.exists) return res.status(404).json({ ok:false, error:"Incident not found" });

    return res.json({ ok:true, incident: { id: snap.id, ...snap.data() } });
  } catch (e) {
    return res.status(400).json({ ok:false, error:String(e) });
  }
});

// ATTACH EVIDENCE (stub)
export const attachEvidenceStub = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Use POST" });
    const body = (req.body && typeof req.body === "object") ? req.body : {};

    const incidentId = requireStr(body.incidentId, "incidentId");
    const orgId = requireStr(body.orgId, "orgId");

    const evidenceId = optionalStr(body.evidenceId) || `ev_${Math.random().toString(36).slice(2, 10)}`;
    const createdAt = nowIso();

    const db = getFirestore();
    await db.collection("incidents").doc(incidentId).collection("evidence").doc(evidenceId).set({
      id: evidenceId,
      orgId,
      incidentId,
      type: body.type || "OTHER",
      status: body.status || "PENDING",
      title: optionalStr(body.title),
      description: optionalStr(body.description),
      createdAt,
      updatedAt: createdAt
    }, { merge: true });

    await db.collection("system_logs").doc().set({
      orgId,
      incidentId,
      level: "INFO",
      event: "evidence.attached",
      message: "Evidence attached (stub)",
      context: { evidenceId },
      actor: { type: "SYSTEM" },
      createdAt
    });

    return res.json({ ok:true, evidenceId });
  } catch (e) {
    return res.status(400).json({ ok:false, error:String(e) });
  }
});
