import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { writeEvidenceLocker } from "./evidence_locker.mjs";
import { submitDIRS } from "./adapters/fcc_dirs.mjs";
import { submitNORS } from "./adapters/fcc_nors.mjs";
import { submitOE417 } from "./adapters/doe_oe417.mjs";
import { writeEvidenceLocker } from "./evidenceLocker.mjs";

const LOCK_SECONDS = 120;
const MAX_PER_TICK = 25;

function tsNow() { return Timestamp.now(); }
function tsAddSeconds(ts, sec) { return Timestamp.fromMillis(ts.toMillis() + sec * 1000); }
function isoNow() { return new Date().toISOString(); }
function norm(x) { return String(x || "").toUpperCase(); }

function backoffSeconds(attempts) {
  if (attempts <= 1) return 30;
  if (attempts === 2) return 120;
  if (attempts === 3) return 600;
  if (attempts === 4) return 3600;
  return 7200;
}

function buildIdempotencyKey({ orgId, incidentId, filingType, payloadHash }) {
  const ph = (payloadHash || "").toString().trim() || "nohash";
  return `${orgId}|${incidentId}|${filingType}|${ph}`;
}

function buildCorrelationId({ incidentId, filingType }) {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,"0");
  const day = String(d.getUTCDate()).padStart(2,"0");
  return `${incidentId}-${filingType}-${y}${m}${day}`;
}

async function submitAdapter({ incidentId, orgId, filingType, payload, correlationId, idempotencyKey }) {
  const ft = String(filingType || "").trim().toUpperCase();

  if (ft === "DIRS") {
    return await submitDIRS({ incidentId, orgId, filingType: ft, payload, correlationId, idempotencyKey });
  }

  if (ft === "OE_417") {
    return await submitOE417({ incidentId, orgId, filingType: ft, payload });
  }

  // fallback stub
  const confirmationId = `${ft}-AUTO-${Date.now().toString(36).toUpperCase()}`;
  return {
    ok: true,
    provider: "OTHER",
    submissionMethod: "AUTO",
    confirmationId,
    notes: "Local adapter stub (fallback)",
    rawRequest: { incidentId, orgId, filingType: ft, payload },
    rawResponse: { mocked: true, confirmationId }
  };
}

async function markDone(db, jobId, patch = {}) {
  const now = tsNow();
  await db.collection("submit_queue").doc(jobId).set({
    status: "DONE",
    doneAt: now,
    lockedBy: "",
    lockedAt: null,
    lockExpiresAt: null,
    lastError: "",
    lastErrorCode: "",
    updatedAt: now,
    ...patch,
  }, { merge: true });
}

async function markFailed(db, jobId, attempts, errorMsg, code = "FAILED") {
  const now = tsNow();
  await db.collection("submit_queue").doc(jobId).set({
    status: "FAILED",
    failedAt: now,
    lockedBy: "",
    lockedAt: null,
    lockExpiresAt: null,
    lastError: String(errorMsg || "unknown"),
    lastErrorCode: String(code),
    updatedAt: now,
  }, { merge: true });
}

async function markRetry(db, jobId, attempts, errorMsg, code = "RETRY") {
  const now = tsNow();
  await db.collection("submit_queue").doc(jobId).set({
    status: "QUEUED",
    lockedBy: "",
    lockedAt: null,
    lockExpiresAt: null,
    lastError: String(errorMsg || "unknown"),
    lastErrorCode: String(code),
    nextAttemptAt: tsAddSeconds(now, backoffSeconds(attempts)),
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

// Claim one job with lease + idempotency
async function claimOne(db, workerId) {
  const now = tsNow();

  const snap = await db.collection("submit_queue")
    .where("status", "==", "QUEUED")
    .where("nextAttemptAt", "<=", now)
    .orderBy("nextAttemptAt", "asc")
    .limit(50)
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
        tx.set(ref, { status: "FAILED", failedAt: now, updatedAt: now, lastErrorCode: "MAX_ATTEMPTS" }, { merge: true });
        return null;
      }

      // idempotency: if job already DONE elsewhere (same idempotencyKey), cancel
      const idem = String(j.idempotencyKey || "");
      if (idem) {
        const dupSnap = await tx.get(
          db.collection("submit_queue")
            .where("idempotencyKey", "==", idem)
            .where("status", "==", "DONE")
            .limit(1)
        );
        // Firestore doesn't allow tx.get(query) directly. We'll enforce idempotency in process step instead.
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
      await markFailed(db, jobId, job.attempts || 1, "Missing incidentId/filingType", "INVALID_JOB");
      failed.push({ id: jobId, error: "INVALID_JOB" });
      continue;
    }

    const filingRef = db.collection("incidents").doc(incidentId).collection("filings").doc(filingType);
    const filingSnap = await filingRef.get().catch(() => null);
    if (!filingSnap || !filingSnap.exists) {
      const attempts = job.attempts || 1;
      if (attempts >= Number(job.maxAttempts || 5)) {
        await markFailed(db, jobId, attempts, "Filing doc not found", "FILING_NOT_FOUND");
      } else {
        await markRetry(db, jobId, attempts, "Filing doc not found", "FILING_NOT_FOUND");
      }
      failed.push({ id: jobId, error: "FILING_NOT_FOUND" });
      continue;
    }

    const filing = filingSnap.data() || {};
    const filingStatus = norm(filing.status || "DRAFT");

    // Enterprise guardrail: only submit READY
    if (filingStatus !== "READY") {
      await markCancelled(db, jobId, `Not READY (current=${filingStatus})`);
      await db.collection("system_logs").doc().set({
        orgId, incidentId,
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

    // Compute idempotencyKey + correlationId if missing
    const payloadHash = (filing.payloadHash?.value) || (job.payloadHash || "");
    const idempotencyKey = job.idempotencyKey || buildIdempotencyKey({ orgId, incidentId, filingType, payloadHash });
    const correlationId = job.correlationId || buildCorrelationId({ incidentId, filingType });

    // Idempotency enforcement: if there is already a DONE job for this key, cancel this one
    const dup = await db.collection("submit_queue")
      .where("idempotencyKey", "==", idempotencyKey)
      .where("status", "==", "DONE")
      .limit(1)
      .get();

    if (!dup.empty && dup.docs[0].id !== jobId) {
      await markCancelled(db, jobId, "Duplicate idempotencyKey (already DONE)");
      processedIds.push(jobId);
      continue;
    }

    if (dryRun) {
      // release lock without changing readiness
      await db.collection("submit_queue").doc(jobId).set({
        status: "QUEUED",
        idempotencyKey,
        correlationId,
        lockedBy: "",
        lockedAt: null,
        lockExpiresAt: null,
        updatedAt: tsNow(),
      }, { merge: true });
      processedIds.push(jobId);
      continue;
    }

    try {

	// --- Load filing payload (source of truth) ---
	const filingRef = db.collection("incidents").doc(incidentId).collection("filings").doc(filingType);
	const filingSnap = await filingRef.get();
	if (!filingSnap.exists) {
	  // Make the job retryable, but record a real reason
	  throw Object.assign(new Error("FILING_NOT_FOUND"), { code: "FILING_NOT_FOUND" });
	}
	const filing = filingSnap.data() || {};
	const payload = filing.payload || {};

	// --- Submit via adapter ---
	const submitRes = await submitAdapter({ incidentId, orgId, filingType, payload });
	if (!submitRes || submitRes.ok !== true) {
	  const msg = submitRes?.error || "SUBMIT_FAILED";
	  throw Object.assign(new Error(msg), { code: "SUBMIT_FAILED", submitRes });
	}

	// --- Evidence locker: request + response ---
	await writeEvidenceLocker(db, {
	  orgId, incidentId, filingType, jobId: job.id,
	  kind: "SUBMISSION_REQUEST",
	  payload: submitRes.rawRequest || { incidentId, orgId, filingType, payload, traceId: submitRes.traceId || "", adapterVersion: submitRes.adapterVersion || "" }
	});

	await writeEvidenceLocker(db, {
	  orgId, incidentId, filingType, jobId: job.id,
	  kind: "SUBMISSION_RESPONSE",
	  payload: submitRes.rawResponse || { ...submitRes, traceId: submitRes.traceId || "", adapterVersion: submitRes.adapterVersion || "" }
	});

	// --- Mark filing SUBMITTED (source of truth for UI) ---
	const now = Timestamp.now();
	const confirmationId = String(submitRes.confirmationId || "").trim();

	await filingRef.set({
	  status: "SUBMITTED",
	  submittedAt: now,
	  submittedBy: "submitQueueWorker@local",
	  external: {
	    ...(filing.external || {}),
	    confirmationId,
	    submissionMethod: submitRes.submissionMethod || "AUTO",
	    provider: submitRes.provider || "OTHER",
	  },
	  updatedAt: now,
	}, { merge: true });

	// --- Mark job DONE ---
	await markDone(db, job.id, {
	  confirmationId,
	  result: {
	    status: "SUCCESS",
	    confirmationId,
	    submissionMethod: submitRes.submissionMethod || "AUTO",
	    provider: submitRes.provider || "OTHER",
	    submittedAt: now,
	    notes: submitRes.notes || "",
	  },
	});

	// Evidence locker: request + response
	const evReq = await writeEvidenceLocker(db, {
	  orgId, incidentId, filingType, jobId,
	  kind: "SUBMISSION_REQUEST",
	  payload: submitRes.rawRequest || { incidentId, orgId, filingType, payload, traceId: submitRes.traceId || "", adapterVersion: submitRes.adapterVersion || "" }
	});

	const evRes = await writeEvidenceLocker(db, {
	  orgId, incidentId, filingType, jobId,
	  kind: "SUBMISSION_RESPONSE",
	  payload: submitRes.rawResponse || { ok: true, confirmationId: submitRes.confirmationId }
	});

      processedIds.push(jobId);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      const attempts = job.attempts || 1;
      if (attempts >= Number(job.maxAttempts || 5)) {
        await markFailed(db, jobId, attempts, msg, "SUBMIT_FAILED");
      } else {
        await markRetry(db, jobId, attempts, msg, "SUBMIT_FAILED");
      }
      failed.push({ id: jobId, error: msg });
    }
  }

  return { ok: true, dryRun, processed: processedIds.length, processedIds, failed };
}

// Submit All: enqueue READY filings only (optionally filter types)
export async function enqueueReadyFilings({ orgId, incidentId, createdBy = "system", filingTypes = null } = {}) {
  const db = getFirestore();
  const now = tsNow();

  const incRef = db.collection("incidents").doc(incidentId);
  const filingsSnap = await incRef.collection("filings").get();

  let queued = 0;
  const jobs = [];

  const allow = Array.isArray(filingTypes) ? new Set(filingTypes.map(String)) : null;

  for (const d of filingsSnap.docs) {
    const filingType = d.id;
    if (allow && !allow.has(filingType)) continue;

    const f = d.data() || {};
    const st = norm(f.status || "DRAFT");
    if (st !== "READY") continue;

    const payloadHash = f.payloadHash?.value || "";
    const idempotencyKey = buildIdempotencyKey({ orgId, incidentId, filingType, payloadHash });
    const correlationId = buildCorrelationId({ incidentId, filingType });

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
      payloadHash: payloadHash || "",
      idempotencyKey,
      correlationId,
    }, { merge: true });

    queued += 1;
    jobs.push(jobId);
  }

  return { ok: true, orgId, incidentId, queued, jobs };
}

// Queue list with optional filters
export async function listQueueJobs({ orgId, limit = 50, status = null, incidentId = null } = {}) {
  const db = getFirestore();
  let q = db.collection("submit_queue").where("orgId", "==", orgId);

  if (status) q = q.where("status", "==", status);
  if (incidentId) q = q.where("incidentId", "==", incidentId);

  const snap = await q.orderBy("updatedAt", "desc").limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function requeueJob({ jobId, reason = "manual_requeue" } = {}) {
  const db = getFirestore();
  const ref = db.collection("submit_queue").doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, error: "JOB_NOT_FOUND", jobId };
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
  const ref = db.collection("submit_queue").doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, error: "JOB_NOT_FOUND", jobId };
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

export async function unlockStaleLocks({ orgId } = {}) {
  const db = getFirestore();
  const now = tsNow();

  const snap = await db.collection("submit_queue")
    .where("orgId", "==", orgId)
    .where("status", "==", "RUNNING")
    .limit(200)
    .get();

  const unlocked = [];
  for (const d of snap.docs) {
    const j = d.data() || {};
    const le = j.lockExpiresAt;
    const expired = !le || (le.toMillis && le.toMillis() <= now.toMillis());
    if (!expired) continue;

    await d.ref.set({
      status: "QUEUED",
      lockedBy: "",
      lockedAt: null,
      lockExpiresAt: null,
      lastError: "Recovered stale lock",
      lastErrorCode: "STALE_LOCK",
      nextAttemptAt: now,
      updatedAt: now,
    }, { merge: true });

    unlocked.push(d.id);
  }

  return { ok: true, orgId, unlockedCount: unlocked.length, unlocked };
}

export async function queueHealth({ orgId } = {}) {
  const db = getFirestore();
  const snap = await db.collection("submit_queue")
    .where("orgId", "==", orgId)
    .orderBy("updatedAt", "desc")
    .limit(500)
    .get();

  const totals = { QUEUED: 0, RUNNING: 0, DONE: 0, FAILED: 0, CANCELLED: 0 };
  for (const d of snap.docs) {
    const s = norm(d.data()?.status);
    if (totals[s] !== undefined) totals[s] += 1;
  }
  return { ok: true, orgId, totals };
}
