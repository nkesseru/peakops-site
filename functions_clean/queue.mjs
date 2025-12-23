import { getFirestore, Timestamp } from "firebase-admin/firestore";

const LOCK_SECONDS = 120;
const MAX_PER_TICK = 10;

function tsNow() { return Timestamp.now(); }
function tsAddSeconds(ts, sec) { return Timestamp.fromMillis(ts.toMillis() + sec * 1000); }
function isoNow() { return new Date().toISOString(); }

function normalizeStatus(x) { return String(x || "").toUpperCase(); }

function backoffSeconds(attempts) {
  if (attempts <= 1) return 30;
  if (attempts === 2) return 120;
  if (attempts === 3) return 600;
  if (attempts === 4) return 3600;
  return 7200;
}

// ----- Submission adapter (stub for now) -----
function submitAdapter(job) {
  // Later: per filingType submission integration
  const t = String(job.filingType || "UNK");
  return {
    ok: true,
    confirmationId: `${t}-AUTO-${Date.now().toString(36).toUpperCase()}`,
    submissionMethod: "AUTO",
  };
}

// ----- Lock/claim -----
async function claimOne(db, workerId) {
  const now = tsNow();

  const snap = await db.collection("submit_queue")
    .where("status", "==", "QUEUED")
    .where("nextAttemptAt", "<=", now)
    .orderBy("nextAttemptAt", "asc")
    .limit(25)
    .get();

  for (const d of snap.docs) {
    const ref = d.ref;

    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) return null;

      const j = fresh.data() || {};
      if (String(j.status) !== "QUEUED") return null;

      const le = j.lockExpiresAt;
      const lockedBy = (j.lockedBy || "").toString().trim();
      const lockExpired = !le || (le.toMillis && le.toMillis() <= now.toMillis());
      if (lockedBy && !lockExpired) return null;

      const attempts = Number(j.attempts || 0);
      const maxAttempts = Number(j.maxAttempts || 5);
      if (attempts >= maxAttempts) {
        tx.set(ref, { status: "FAILED", updatedAt: now, lastErrorCode: "MAX_ATTEMPTS" }, { merge: true });
        return null;
      }

      tx.set(ref, {
        status: "RUNNING",
        lockedBy: workerId,
        lockedAt: now,
        lockExpiresAt: tsAddSeconds(now, LOCK_SECONDS),
        attempts: attempts + 1,
        lastAttemptAt: now,
        updatedAt: now,
      }, { merge: true });

      return { id: fresh.id, ...j, attempts: attempts + 1 };
    });

    if (claimed) return claimed;
  }

  return null;
}

async function markDone(db, jobId, patch = {}) {
  const now = tsNow();
  await db.collection("submit_queue").doc(jobId).set({
    status: "DONE",
    lockedBy: "",
    lockedAt: null,
    lockExpiresAt: null,
    updatedAt: now,
    ...patch,
  }, { merge: true });
}

async function markRetry(db, jobId, attempts, errorMsg, code = "WORKER_ERROR") {
  const now = tsNow();
  const backoff = backoffSeconds(attempts);

  await db.collection("submit_queue").doc(jobId).set({
    status: "QUEUED",
    lockedBy: "",
    lockedAt: null,
    lockExpiresAt: null,
    lastError: String(errorMsg || "unknown"),
    lastErrorCode: String(code),
    nextAttemptAt: tsAddSeconds(now, backoff),
    updatedAt: now,
  }, { merge: true });
}

async function markCancelled(db, jobId, reason = "cancelled") {
  const now = tsNow();
  await db.collection("submit_queue").doc(jobId).set({
    status: "CANCELLED",
    lockedBy: "",
    lockedAt: null,
    lockExpiresAt: null,
    lastError: String(reason),
    lastErrorCode: "CANCELLED",
    updatedAt: now,
  }, { merge: true });
}

// ----- Public worker tick -----
export async function runSubmitQueueTick({ dryRun = false } = {}) {
  const db = getFirestore();
  const workerId = `submitQueueWorker@local`;

  const processedIds = [];
  const failed = [];

  for (let i = 0; i < MAX_PER_TICK; i++) {
    const job = await claimOne(db, workerId);
    if (!job) break;

    const jobId = job.id;
    const orgId = job.orgId || "org_001";
    const incidentId = job.incidentId;
    const filingType = String(job.filingType || "").trim();

    if (!incidentId || !filingType) {
      await markRetry(db, jobId, job.attempts || 1, "Missing incidentId/filingType", "INVALID_JOB");
      failed.push({ id: jobId, error: "INVALID_JOB" });
      continue;
    }

    const filingRef = db.collection("incidents").doc(incidentId).collection("filings").doc(filingType);
    const filingSnap = await filingRef.get().catch(() => null);

    if (!filingSnap || !filingSnap.exists) {
      await markRetry(db, jobId, job.attempts || 1, "Filing doc not found", "FILING_NOT_FOUND");
      failed.push({ id: jobId, error: "FILING_NOT_FOUND" });
      continue;
    }

    const filing = filingSnap.data() || {};
    const filingStatus = normalizeStatus(filing.status || "DRAFT");

    if (filingStatus !== "READY") {
      await markCancelled(db, jobId, `Not READY (current=${filingStatus})`);
      await db.collection("system_logs").doc().set({
        orgId,
        incidentId,
        level: "WARN",
        event: "submitqueue.job.cancelled",
        message: "Queue job cancelled: filing not READY",
        context: { jobId, filingType, filingStatus },
        actor: { type: "SYSTEM" },
        createdAt: isoNow(),
      });
      processedIds.push(jobId);
      continue;
    }

    if (dryRun) {
      await db.collection("submit_queue").doc(jobId).set({
        status: "QUEUED",
        lockedBy: "",
        lockedAt: null,
        lockExpiresAt: null,
        updatedAt: tsNow(),
      }, { merge: true });
      processedIds.push(jobId);
      continue;
    }

    try {
      const sub = submitAdapter(job);
      if (!sub.ok) throw new Error("submitAdapter failed");

      const nowISO = isoNow();
      const confirmationId = sub.confirmationId;
      const submissionMethod = sub.submissionMethod || "AUTO";

      // Filing -> SUBMITTED
      await filingRef.set({
        status: "SUBMITTED",
        submittedAt: nowISO,
        submittedBy: workerId,
        external: {
          ...(filing.external || {}),
          confirmationId,
          submissionMethod,
        },
        updatedAt: nowISO,
      }, { merge: true });

      // filing_action_logs
      const actionRef = db.collection("filing_action_logs").doc();
      await actionRef.set({
        orgId,
        incidentId,
        filingType,
        userId: workerId,
        action: "status_changed",
        from: "READY",
        to: "SUBMITTED",
        message: "Auto-submitted by SubmitQueue",
        context: { confirmationId, submissionMethod, jobId },
        createdAt: nowISO,
      });

      // timeline event
      const tlRef = db.collection("incidents").doc(incidentId).collection("timelineEvents").doc();
      await tlRef.set({
        id: tlRef.id,
        orgId,
        incidentId,
        type: "FILING_SUBMITTED",
        occurredAt: nowISO,
        title: `Filing submitted: ${filingType}`,
        message: `Submitted (${submissionMethod}) · Confirmation: ${confirmationId}`,
        links: { filingId: filingType, userId: workerId },
        source: "SYSTEM",
        createdAt: nowISO,
      }, { merge: true });

      await markDone(db, jobId, { confirmationId, submissionMethod });

      await db.collection("system_logs").doc().set({
        orgId,
        incidentId,
        level: "INFO",
        event: "submitqueue.job.done",
        message: `SubmitQueue submitted ${filingType}`,
        context: { jobId, confirmationId, submissionMethod },
        actor: { type: "SYSTEM" },
        createdAt: nowISO,
      });

      processedIds.push(jobId);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      await markRetry(db, jobId, job.attempts || 1, msg, "SUBMIT_FAILED");
      failed.push({ id: jobId, error: msg });
    }
  }

  return { ok: true, dryRun, processed: processedIds.length, processedIds, failed };
}

// ----- Submit All (enqueue READY filings) -----
export async function enqueueReadyFilings({ orgId, incidentId, createdBy = "system" } = {}) {
  const db = getFirestore();
  const now = tsNow();

  const incRef = db.collection("incidents").doc(incidentId);
  const filingsSnap = await incRef.collection("filings").get();

  let queued = 0;
  const jobs = [];

  for (const d of filingsSnap.docs) {
    const filingType = d.id;
    const f = d.data() || {};
    const st = normalizeStatus(f.status || "DRAFT");
    if (st !== "READY") continue;

    const jobId = `job_${incidentId}_${filingType}`;
    await db.collection("submit_queue").doc(jobId).set({
      orgId,
      incidentId,
      filingType,
      status: "QUEUED",
      priority: 100,
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: now,
      lockedBy: "",
      lockedAt: null,
      lockExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy,
      submissionMethod: "AUTO",
      lastError: "",
      lastErrorCode: "",
      confirmationId: "",
      payloadHash: "",
    }, { merge: true });

    queued += 1;
    jobs.push(jobId);
  }

  return { ok: true, orgId, incidentId, queued, jobs };
}

// ----- UI helpers -----
export async function listQueueJobs({ orgId, limit = 50 } = {}) {
  const db = getFirestore();
  const snap = await db.collection("submit_queue")
    .where("orgId", "==", orgId)
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function requeueJob({ jobId, reason = "manual_requeue" } = {}) {
  const db = getFirestore();
  const now = tsNow();
  await db.collection("submit_queue").doc(jobId).set({
    status: "QUEUED",
    lockedBy: "",
    lockedAt: null,
    lockExpiresAt: null,
    nextAttemptAt: now,
    lastError: reason,
    lastErrorCode: "MANUAL_REQUEUE",
    updatedAt: now,
  }, { merge: true });
  return { ok: true, jobId };
}

export async function cancelJob({ jobId, reason = "manual_cancel" } = {}) {
  const db = getFirestore();
  const now = tsNow();
  await db.collection("submit_queue").doc(jobId).set({
    status: "CANCELLED",
    lockedBy: "",
    lockedAt: null,
    lockExpiresAt: null,
    lastError: reason,
    lastErrorCode: "MANUAL_CANCEL",
    updatedAt: now,
  }, { merge: true });
  return { ok: true, jobId };
}
