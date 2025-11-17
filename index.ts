import * as functions from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import * as admin from "firebase-admin";
import crypto from "crypto";

// ---------- INIT ----------
if (!admin.apps.length) admin.initializeApp();
const db = getFirestore();

const DIRS_URL = (functions.config().dirs?.url as string) || "";
const DIRS_AUTH = (functions.config().dirs?.auth as string) || "";
const TIMEOUT_MS = Number(functions.config().net?.timeout_ms || 10000);

const BATCH_LIMIT = 20;          // how many queued to lease per tick
const LEASE_SECONDS = 120;       // processing lease window
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;       // backoff base (ms)

// ---------- UTIL ----------
function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
function jitter(n: number) {
  return Math.floor(n * (0.85 + Math.random() * 0.3)); // ±15%
}
function backoffDelay(attempt: number) {
  // attempt 1..MAX_RETRIES
  return jitter(BASE_DELAY_MS * Math.pow(2, attempt - 1));
}

function stableIdempotencyKey(submissionId: string, system: string) {
  // stable per (doc, system)
  return crypto.createHash("sha256").update(`${submissionId}:${system}`).digest("hex");
}

async function takeLease(submissionId: string, runnerId: string) {
  const ref = db.collection("submissions").doc(submissionId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;

    const data = snap.data()!;
    if (data.status !== "queued" && data.status !== "processing") return false;

    const now = Timestamp.now();
    const lease = data.lease || { until: null, by: null };
    const leaseExpired =
      !lease.until || (lease.until.toMillis && lease.until.toMillis() < now.toMillis());

    if (!leaseExpired && data.status === "processing") return false;

    tx.update(ref, {
      status: "processing",
      lease: { until: Timestamp.fromMillis(now.toMillis() + LEASE_SECONDS * 1000), by: runnerId },
      // seed idempotency if missing
      idempotencyKey: data.idempotencyKey || stableIdempotencyKey(submissionId, data.target || "FCC_DIRS"),
    });
    return true;
  });
}

async function logReceipt(
  refPath: FirebaseFirestore.DocumentReference,
  entry: {
    system: string;
    status: "success" | "error";
    attempt: number;
    httpCode?: number;
    receiptId?: string;
    responseSnippet?: string;
  }
) {
  await refPath.update({
    receipts: FieldValue.arrayUnion({
      ts: Timestamp.now(),
      ...entry,
    }),
  });
}

async function markSubmitted(refPath: FirebaseFirestore.DocumentReference) {
  await refPath.update({
    status: "submitted",
    lease: { until: null, by: null },
    lastError: null,
  });
}

async function markFailed(refPath: FirebaseFirestore.DocumentReference, code?: number, message?: string) {
  await refPath.update({
    status: "failed",
    lease: { until: null, by: null },
    lastError: { code: code || null, message: message || "Unspecified error" },
  });
}

async function incrementAttempts(refPath: FirebaseFirestore.DocumentReference) {
  await refPath.update({ attempts: FieldValue.increment(1) });
}

// ---------- OUTBOUND ----------
async function postToFccDirs(
  body: unknown,
  idempotencyKey: string
): Promise<{ ok: boolean; httpCode: number; receiptId?: string; text?: string }> {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(DIRS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(DIRS_AUTH ? { Authorization: DIRS_AUTH } : {}),
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    clearTimeout(to);

    // Try to parse a receiptId if present
    let receiptId: string | undefined = undefined;
    try {
      const j = JSON.parse(text);
      receiptId = j?.receiptId || j?.id || j?.data?.receiptId;
    } catch {
      // swallow
    }

    return { ok: res.ok || !!receiptId, httpCode: res.status, receiptId, text: text?.slice(0, 8000) };
  } catch (e: any) {
    clearTimeout(to);
    return { ok: false, httpCode: 0, text: String(e?.message || e) };
  }
}

// ---------- CORE ----------
async function handleOne(submissionId: string, runnerId: string) {
  const ref = db.collection("submissions").doc(submissionId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const data = snap.data()!;
  const target = (data.target || "FCC_DIRS") as string;
  const idempotencyKey: string = data.idempotencyKey || stableIdempotencyKey(submissionId, target);
  const payload = data.payload;

  if (!DIRS_URL) {
    await logReceipt(ref, {
      system: "FCC_DIRS",
      status: "error",
      attempt: (data.attempts || 0) + 1,
      responseSnippet: "dirs.url unset",
    });
    await markFailed(ref, 500, "dirs.url unset");
    return;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await incrementAttempts(ref);

    const resp = await postToFccDirs(payload, idempotencyKey);
    await logReceipt(ref, {
      system: "FCC_DIRS",
      status: resp.ok ? "success" : "error",
      attempt,
      httpCode: resp.httpCode,
      receiptId: resp.receiptId,
      responseSnippet: resp.text,
    });

    if (resp.ok) {
      await markSubmitted(ref);
      return;
    }

    if (attempt < MAX_RETRIES) {
      await sleep(backoffDelay(attempt));
      // refresh lease mid-flight
      await ref.update({
        lease: {
          until: Timestamp.fromMillis(Timestamp.now().toMillis() + LEASE_SECONDS * 1000),
          by: runnerId,
        },
      });
    } else {
      await markFailed(ref, resp.httpCode, "Max retries exceeded");
    }
  }
}

// Pulls a small batch of eligible docs, leases, and processes them.
async function workBatch(runnerId: string) {
  const now = Timestamp.now();
  const q = db
    .collection("submissions")
    .where("status", "in", ["queued", "processing"])
    .orderBy("status", "asc")
    .limit(BATCH_LIMIT);

  const snap = await q.get();
  const candidates: string[] = [];

  snap.forEach((doc) => {
    const d = doc.data() as any;
    const lease = d.lease || {};
    const expired =
      !lease.until || (lease.until.toMillis && lease.until.toMillis() < now.toMillis());
    if (d.status === "queued" || (d.status === "processing" && expired)) {
      candidates.push(doc.id);
    }
  });

  // Take leases
  const leased: string[] = [];
  await Promise.all(
    candidates.map(async (id) => {
      const ok = await takeLease(id, runnerId);
      if (ok) leased.push(id);
    })
  );

  // Process in parallel but not too wild
  await Promise.all(leased.map((id) => handleOne(id, runnerId)));
}

// ---------- TRIGGERS ----------

// 1) Scheduled worker (every minute; adjust to your needs)
export const processQueuedSubmissions = onSchedule(
  {
    schedule: "*/1 * * * *",
    timeZone: "America/Los_Angeles",
    memory: "512MiB",
    cpu: 1,
    region: "us-west1",
    concurrency: 10,
  },
  async () => {
    const runnerId = `sched-${crypto.randomUUID().slice(0, 8)}`;
    await workBatch(runnerId);
  }
);

// 2) Manual HTTP kicker (for testing or ad-hoc runs)
export const kickProcessQueuedSubmissions = onRequest(
  {
    region: "us-west1",
    invoker: "public", // tighten if desired
    memory: "512MiB",
    cpu: 1,
  },
  async (req, res) => {
    const runnerId = `http-${crypto.randomUUID().slice(0, 8)}`;
    await workBatch(runnerId);
    res.status(200).json({ ok: true, runnerId });
  }
);
