"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.kickProcessQueuedSubmissions = exports.processQueuedSubmissions = void 0;
const functions = __importStar(require("firebase-functions/v2"));
const scheduler_1 = require("firebase-functions/v2/scheduler");
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const admin = __importStar(require("firebase-admin"));
const crypto_1 = __importDefault(require("crypto"));
if (!admin.apps.length)
    admin.initializeApp();
const db = (0, firestore_1.getFirestore)();
// Prefer dotenv in Gen2; envs are already loaded by Firebase CLI if .env exists in codebase
const DIRS_URL = (process.env.DIRS_URL || functions.config().dirs?.url || "").trim();
const DIRS_AUTH = (process.env.DIRS_AUTH || functions.config().dirs?.auth || "").trim();
const TIMEOUT_MS = Number(process.env.NET_TIMEOUT_MS || functions.config().net?.timeout_ms || 10000);
const BATCH_LIMIT = 20;
const LEASE_SECONDS = 120;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
function jitter(n) { return Math.floor(n * (0.85 + Math.random() * 0.3)); }
function backoffDelay(attempt) { return jitter(BASE_DELAY_MS * Math.pow(2, attempt - 1)); }
function stableIdempotencyKey(submissionId, system) {
    return crypto_1.default.createHash("sha256").update(`${submissionId}:${system}`).digest("hex");
}
async function takeLease(submissionId, runnerId) {
    const ref = db.collection("submissions").doc(submissionId);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists)
            return false;
        const data = snap.data();
        if (data.status !== "queued" && data.status !== "processing")
            return false;
        const now = firestore_1.Timestamp.now();
        const lease = data.lease || { until: null, by: null };
        const leaseExpired = !lease.until || (lease.until.toMillis && lease.until.toMillis() < now.toMillis());
        if (!leaseExpired && data.status === "processing")
            return false;
        tx.update(ref, {
            status: "processing",
            lease: { until: firestore_1.Timestamp.fromMillis(now.toMillis() + LEASE_SECONDS * 1000), by: runnerId },
            idempotencyKey: data.idempotencyKey || stableIdempotencyKey(submissionId, data.target || "FCC_DIRS"),
        });
        return true;
    });
}
async function logReceipt(ref, entry) {
    await ref.update({ receipts: firestore_1.FieldValue.arrayUnion({ ts: firestore_1.Timestamp.now(), ...entry }) });
}
async function markSubmitted(ref) {
    await ref.update({ status: "submitted", lease: { until: null, by: null }, lastError: null });
}
async function markFailed(ref, code, message) {
    await ref.update({ status: "failed", lease: { until: null, by: null }, lastError: { code: code || null, message: message || "Unspecified error" } });
}
async function incrementAttempts(ref) {
    await ref.update({ attempts: firestore_1.FieldValue.increment(1) });
}
async function postToFccDirs(body, idempotencyKey) {
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
        let receiptId;
        try {
            const j = JSON.parse(text);
            receiptId = j?.receiptId || j?.id || j?.data?.receiptId;
        }
        catch { }
        return { ok: res.ok || !!receiptId, httpCode: res.status, receiptId, text: text?.slice(0, 8000) };
    }
    catch (e) {
        clearTimeout(to);
        return { ok: false, httpCode: 0, text: String(e?.message || e) };
    }
}
async function handleOne(submissionId, runnerId) {
    const ref = db.collection("submissions").doc(submissionId);
    const snap = await ref.get();
    if (!snap.exists)
        return;
    const data = snap.data();
    const target = (data.target || "FCC_DIRS");
    const idempotencyKey = data.idempotencyKey || stableIdempotencyKey(submissionId, target);
    const payload = data.payload;
    if (!DIRS_URL) {
        await logReceipt(ref, { system: "FCC_DIRS", status: "error", attempt: (data.attempts || 0) + 1, responseSnippet: "dirs.url unset" });
        await markFailed(ref, 500, "dirs.url unset");
        return;
    }
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        await incrementAttempts(ref);
        const resp = await postToFccDirs(payload, idempotencyKey);
        await logReceipt(ref, { system: "FCC_DIRS", status: resp.ok ? "success" : "error", attempt, httpCode: resp.httpCode, receiptId: resp.receiptId, responseSnippet: resp.text });
        if (resp.ok) {
            await markSubmitted(ref);
            return;
        }
        if (attempt < MAX_RETRIES) {
            await sleep(backoffDelay(attempt));
            await ref.update({ lease: { until: firestore_1.Timestamp.fromMillis(firestore_1.Timestamp.now().toMillis() + LEASE_SECONDS * 1000), by: runnerId } });
        }
        else {
            await markFailed(ref, resp.httpCode, "Max retries exceeded");
        }
    }
}
async function workBatch(runnerId) {
    const now = firestore_1.Timestamp.now();
    const q = db.collection("submissions").where("status", "in", ["queued", "processing"]).orderBy("status", "asc").limit(BATCH_LIMIT);
    const snap = await q.get();
    const candidates = [];
    snap.forEach((doc) => {
        const d = doc.data();
        const lease = d.lease || {};
        const expired = !lease.until || (lease.until.toMillis && lease.until.toMillis() < now.toMillis());
        if (d.status === "queued" || (d.status === "processing" && expired))
            candidates.push(doc.id);
    });
    const leased = [];
    await Promise.all(candidates.map(async (id) => { if (await takeLease(id, runnerId))
        leased.push(id); }));
    await Promise.all(leased.map((id) => handleOne(id, runnerId)));
}
exports.processQueuedSubmissions = (0, scheduler_1.onSchedule)({ schedule: "*/1 * * * *", timeZone: "America/Los_Angeles", memory: "512MiB", cpu: 1, region: "us-west1", concurrency: 10 }, async () => { const runnerId = `sched-${crypto_1.default.randomUUID().slice(0, 8)}`; await workBatch(runnerId); });
exports.kickProcessQueuedSubmissions = (0, https_1.onRequest)({ region: "us-west1", invoker: "public", memory: "512MiB", cpu: 1 }, async (_req, res) => {
    const runnerId = `http-${crypto_1.default.randomUUID().slice(0, 8)}`;
    await workBatch(runnerId);
    res.status(200).json({ ok: true, runnerId });
});
