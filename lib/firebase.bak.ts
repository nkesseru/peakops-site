// PeakOps Cloud Functions — Ingest Suite (TypeScript stubs v1)
// Firebase v2-compatible. Minimal, bomb‑proof scaffolding with HMAC, idempotency,
// transactional writes, and pluggable OCR/parser utilities.
//
// Files are delineated by `// FILE:` headers. Copy into your repo 1:1.
// -----------------------------------------------------------------------------

// FILE: package.json
{
  "name": "peakops-ingest-functions",
  "version": "0.1.0",
  "private": true,
  "engines": { "node": ">=18" },
  "type": "module",
  "dependencies": {
    "firebase-admin": "^12.5.0",
    "firebase-functions": "^5.0.0",
    "fast-hash": "^1.2.1",
    "zod": "^3.23.8",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "typescript": "^5.5.4"
  },
  "scripts": {
    "build": "tsc -p .",
    "deploy": "firebase deploy --only functions"
  }
}

// FILE: tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "outDir": "lib",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}

// FILE: src/config.ts
export const CFG = {
  PROJECT_ID: process.env.GCP_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? "",
  REGION: process.env.GCP_REGION ?? "us-central1",
  BUCKET: process.env.GCS_BUCKET ?? "peakops-ingest",
  TIMEZONE: process.env.TIMEZONE ?? "America/Los_Angeles",
  HMAC_SECRET: process.env.ZAPIER_SIGNING_SECRET ?? "",
};

if (!CFG.PROJECT_ID) console.warn("[config] PROJECT_ID missing");
if (!CFG.HMAC_SECRET) console.warn("[config] HMAC secret missing — set ZAPIER_SIGNING_SECRET");

// FILE: src/types.ts
import { z } from "zod";

export const CloseEventSchema = z.object({
  ingestionId: z.string(),
  source: z.enum(["email", "pdf_ocr", "doc_text", "webhook_gmail"]).default("email"),
  vendor: z.string().optional(),
  customerId: z.string(),
  locationId: z.string().optional(),
  jobId: z.string().optional(),
  externalRef: z.string().optional(),
  serviceDate: z.string(), // YYYY-MM-DD
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  performedBy: z.array(z.string()).optional(),
  materialsUsed: z.array(z.object({ name: z.string(), qty: z.number(), unit: z.string().optional(), cost: z.number().optional() })).optional(),
  photos: z.array(z.object({ url: z.string(), label: z.string().optional(), hash: z.string().optional() })).optional(),
  signatures: z.array(z.object({ role: z.enum(["client","tech"]).optional(), url: z.string(), time: z.string().optional() })).optional(),
  status: z.enum(["closed","needs_review","rejected","pending"]).default("closed"),
  subtotal: z.number().optional(),
  taxes: z.number().optional(),
  totalAmount: z.number().optional(),
  notes: z.string().optional(),
  flags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  attachments: z.array(z.object({ type: z.string().optional(), url: z.string().optional(), filename: z.string().optional(), sha256: z.string().optional(), mime: z.string().optional() })).optional(),
  ingestMeta: z.record(z.any()).optional(),
});

export type CloseEvent = z.infer<typeof CloseEventSchema>;

// FILE: src/utils/hmac.ts
import crypto from "crypto";
import { CFG } from "../config.js";

export function verifyHmac(rawBody: string, signatureHeader?: string): boolean {
  if (!signatureHeader) return false;
  const [algo, sig] = signatureHeader.split("=");
  if (!algo || !sig || algo !== "sha256") return false;
  const h = crypto.createHmac("sha256", CFG.HMAC_SECRET);
  h.update(rawBody);
  const expected = h.digest("hex");
  // timing-safe compare
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signBody(rawBody: string): string {
  const h = crypto.createHmac("sha256", CFG.HMAC_SECRET);
  h.update(rawBody);
  return `sha256=${h.digest("hex")}`;
}

// FILE: src/utils/firestore.ts
import * as admin from "firebase-admin";
import { CloseEvent } from "../types.js";
import { nanoid } from "./id.js";

let _inited = false;
export function initAdmin() {
  if (_inited) return; _inited = true;
  try { admin.initializeApp(); } catch {}
}

export async function transactionalWriteCloseEvent(evt: CloseEvent) {
  initAdmin();
  const db = admin.firestore();
  const ingestionId = evt.ingestionId;
  // Deterministic / fallback jobId strategy
  const jobId = evt.jobId || nanoid(10);
  const jobDoc = db.doc(`jobs/${jobId}`);
  const ingestDoc = db.doc(`ingest_jobs/${ingestionId}`);
  const closeEventDoc = jobDoc.collection("close_events").doc(ingestionId);

  await db.runTransaction(async (tx) => {
    const ingestSnap = await tx.get(ingestDoc);
    if (ingestSnap.exists && ingestSnap.get("status") === "written") {
      return; // idempotent no-op
    }
    tx.set(ingestDoc, { status: "received", source: evt.source, jobId, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    // Merge into canonical close map
    tx.set(jobDoc, { close: sanitizeClose(evt), updatedAt: admin.firestore.FieldValue.serverTimestamp(), jobId }, { merge: true });

    // Append raw event
    tx.set(closeEventDoc, { ...evt, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: false });

    tx.set(ingestDoc, { status: "written", writtenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });

  return { jobId, ingestionId };
}

function sanitizeClose(evt: CloseEvent) {
  const { attachments, ...rest } = evt;
  return {
    ...rest,
    attachments: (attachments || []).map(a => ({
      filename: a.filename,
      url: a.url,
      sha256: a.sha256,
      mime: a.mime,
    })),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

export async function logEvent(meta: Record<string, any>) {
  initAdmin();
  const db = admin.firestore();
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}`;
  await db.collection("system_logs").doc(ym).collection("events").add(meta);
}

// FILE: src/utils/storage.ts
import * as admin from "firebase-admin";
import { CFG } from "../config.js";

export async function putBuffer(path: string, buf: Buffer, contentType?: string) {
  const bucket = admin.storage().bucket(CFG.BUCKET);
  const file = bucket.file(path);
  await file.save(buf, { contentType, resumable: false });
  await file.makePrivate({ strict: false });
  return `gs://${CFG.BUCKET}/${path}`;
}

// FILE: src/utils/id.ts
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export function nanoid(len = 10) {
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// FILE: src/utils/req.ts
import { onRequest } from "firebase-functions/v2/https";
import { verifyHmac } from "./hmac.js";

export function secureHandler(handler: (raw: string, body: any, req: any, res: any) => Promise<void>) {
  return onRequest({ cors: true }, async (req, res) => {
    try {
      const raw = typeof req.rawBody === "object" ? req.rawBody.toString() : (req.rawBody ?? "").toString();
      const ok = verifyHmac(raw, req.get("X-Signature"));
      if (!ok) { res.status(401).json({ error: "AUTH_ERROR", message: "Invalid signature" }); return; }
      const body = req.body ?? {};
      await handler(raw, body, req, res);
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "SERVER_ERROR", message: e?.message });
    }
  });
}

// FILE: src/parsers/emailParser.ts
import { CloseEvent } from "../types.js";
export function parseEmailToCloseEvent(input: any): CloseEvent {
  // Minimal stub. Replace with vendor-template-driven logic.
  const evt: CloseEvent = {
    ingestionId: input.ingestionId,
    source: "email",
    vendor: input.vendor,
    customerId: input.customerId,
    locationId: input.locationId,
    externalRef: input.externalRef,
    serviceDate: input.serviceDate,
    startTime: input.startTime,
    endTime: input.endTime,
    performedBy: input.performedBy ?? [],
    notes: input.notes,
    status: (input.status ?? "closed"),
    confidence: input.confidence ?? 0.9,
    attachments: input.attachments ?? [],
    ingestMeta: { parser: "emailParser@v1", gmail: input.gmail },
  };
  return evt;
}

// FILE: src/parsers/ocrParser.ts
import { CloseEvent } from "../types.js";
export function parseOcrResultToCloseEvent(ocr: any): CloseEvent {
  const evt: CloseEvent = {
    ingestionId: ocr.ingestionId,
    source: "pdf_ocr",
    vendor: ocr.vendor,
    customerId: ocr.customerId ?? "unknown_customer",
    locationId: ocr.locationId,
    externalRef: ocr.externalRef,
    serviceDate: ocr.serviceDate,
    notes: ocr.notes,
    status: (ocr.confidence ?? 0) < 0.85 ? "needs_review" : "closed",
    confidence: ocr.confidence ?? 0.7,
    attachments: [{ filename: ocr.filename, url: ocr.gsUrl }],
    ingestMeta: { parser: "ocrParser@v1", fields: ocr.fields },
  };
  return evt;
}

// FILE: src/parsers/docParser.ts
import { CloseEvent } from "../types.js";
export function parseDocToCloseEvent(doc: any): CloseEvent {
  const evt: CloseEvent = {
    ingestionId: doc.ingestionId,
    source: "doc_text",
    vendor: doc.vendor,
    customerId: doc.customerId ?? "unknown_customer",
    locationId: doc.locationId,
    externalRef: doc.externalRef,
    serviceDate: doc.serviceDate,
    notes: doc.notes,
    status: "closed",
    confidence: doc.confidence ?? 0.9,
    attachments: doc.attachments ?? [],
    ingestMeta: { parser: "docParser@v1", extractor: doc.extractor },
  };
  return evt;
}

// FILE: src/index.ts
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { getFirestore } from "firebase-admin/firestore";
import { v4 as uuidv4 } from "uuid";
import { CFG } from "./config.js";
import { CloseEventSchema } from "./types.js";
import { transactionalWriteCloseEvent, logEvent, initAdmin } from "./utils/firestore.js";
import { secureHandler } from "./utils/req.js";
import { parseEmailToCloseEvent } from "./parsers/emailParser.js";
import { parseOcrResultToCloseEvent } from "./parsers/ocrParser.js";
import { parseDocToCloseEvent } from "./parsers/docParser.js";

// Initialize Admin SDK once
initializeApp();
getStorage();
getFirestore();
initAdmin();

// --- A1: ingestEmail --------------------------------------------------------
export const ingestEmail = secureHandler(async (_raw, body, req, res) => {
  const withId = { ingestionId: body.ingestionId || uuidv4(), ...body };
  const parsed = parseEmailToCloseEvent(withId);
  const result = CloseEventSchema.safeParse(parsed);
  if (!result.success) {
    await logEvent({ level: "warn", where: "ingestEmail", reason: "VALIDATION_ERROR", issues: result.error.issues });
    res.status(400).json({ error: "VALIDATION_ERROR", issues: result.error.issues });
    return;
  }
  const { jobId, ingestionId } = await transactionalWriteCloseEvent(result.data);
  res.json({ ok: true, jobId, ingestionId });
});

// --- A2: enqueueOcrJob ------------------------------------------------------
export const enqueueOcrJob = secureHandler(async (_raw, body, _req, res) => {
  // Minimal: store job descriptor in Firestore; a separate worker will process it
  const db = (await import("firebase-admin/firestore")).getFirestore();
  const ingestionId = body.ingestionId || uuidv4();
  await db.collection("ocr_jobs").doc(ingestionId).set({
    ingestionId,
    gsUrl: body.gsUrl,
    vendor: body.vendor ?? null,
    hints: body.hints ?? {},
    status: "queued",
    createdAt: (await import("firebase-admin/firestore")).FieldValue.serverTimestamp(),
  });
  res.json({ ok: true, ingestionId });
});

// --- A2: runOcrWorker (HTTP trigger for simplicity; convert to scheduler/queue later)
export const runOcrWorker = onRequest(async (_req, res) => {
  const db = (await import("firebase-admin/firestore")).getFirestore();
  const snap = await db.collection("ocr_jobs").where("status","==","queued").limit(5).get();
  const jobs = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
  for (const j of jobs) {
    try {
      await db.collection("ocr_jobs").doc(j.id).update({ status: "processing", startedAt: (await import("firebase-admin/firestore")).FieldValue.serverTimestamp() });
      // TODO: Replace with Vision API OCR. Stub result:
      const ocrResult = {
        ingestionId: j.id,
        vendor: j.vendor,
        customerId: "cust_stub",
        serviceDate: new Date().toISOString().slice(0,10),
        externalRef: "WO-STUB",
        filename: j.gsUrl?.split("/").pop(),
        gsUrl: j.gsUrl,
        confidence: 0.9,
        fields: { example: true }
      };
      const evt = parseOcrResultToCloseEvent(ocrResult);
      const { ingestionId } = await transactionalWriteCloseEvent(evt);
      await db.collection("ocr_jobs").doc(j.id).update({ status: "done", finishedAt: (await import("firebase-admin/firestore")).FieldValue.serverTimestamp() });
      await logEvent({ level: "info", where: "runOcrWorker", ingestionId, status: "done" });
    } catch (e: any) {
      console.error(e);
      await db.collection("ocr_jobs").doc(j.id).update({ status: "error", error: String(e) });
      await logEvent({ level: "error", where: "runOcrWorker", job: j.id, error: String(e) });
    }
  }
  res.json({ ok: true, processed: jobs.length });
});

// --- A3: ingestDocText ------------------------------------------------------
export const ingestDocText = secureHandler(async (_raw, body, _req, res) => {
  const withId = { ingestionId: body.ingestionId || uuidv4(), ...body };
  const parsed = parseDocToCloseEvent(withId);
  const result = CloseEventSchema.safeParse(parsed);
  if (!result.success) {
    await logEvent({ level: "warn", where: "ingestDocText", reason: "VALIDATION_ERROR", issues: result.error.issues });
    res.status(400).json({ error: "VALIDATION_ERROR", issues: result.error.issues });
    return;
  }
  const { jobId, ingestionId } = await transactionalWriteCloseEvent(result.data);
  res.json({ ok: true, jobId, ingestionId });
});

// --- A4: gmailWebhook -------------------------------------------------------
export const gmailWebhook = secureHandler(async (_raw, body, _req, res) => {
  const ingestionId = body.ingestionId || uuidv4();
  // Route to OCR if PDFs supplied via gsUrl; otherwise treat as structured email
  const hasPdf = Array.isArray(body.attachments) && body.attachments.some((a: any) => (a.mime ?? a.type) === "application/pdf" || String(a.filename||"").toLowerCase().endsWith(".pdf"));
  if (hasPdf) {
    // Enqueue OCR job
    const db = (await import("firebase-admin/firestore")).getFirestore();
    await db.collection("ocr_jobs").doc(ingestionId).set({
      ingestionId, gsUrl: body.attachments[0]?.dataUrl, vendor: body.vendor ?? null, status: "queued",
      createdAt: (await import("firebase-admin/firestore")).FieldValue.serverTimestamp(),
    });
    res.json({ ok: true, routed: "ocr", ingestionId });
    return;
  }
  const evt = parseEmailToCloseEvent({ ...body, ingestionId, source: "webhook_gmail" });
  const result = CloseEventSchema.safeParse(evt);
  if (!result.success) {
    await logEvent({ level: "warn", where: "gmailWebhook", reason: "VALIDATION_ERROR", issues: result.error.issues });
    res.status(400).json({ error: "VALIDATION_ERROR", issues: result.error.issues });
    return;
  }
  const { jobId } = await transactionalWriteCloseEvent(result.data);
  res.json({ ok: true, jobId, ingestionId });
});

