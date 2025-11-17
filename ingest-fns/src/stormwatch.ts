import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as sendgrid from "@sendgrid/mail";

// Ensure Firebase app is initialized exactly once
if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();

export type StormwatchEvent = {
  timestamp?: FirebaseFirestore.Timestamp;
  orgId?: string | null;
  source?: string | null;
  function: string;
  kind: "INGEST_RUN" | "QUEUE_RUN" | "SUBMISSION_ERROR" | "WARN";
  rowsSent?: number | null;
  accepted?: number | null;
  rejected?: number | null;
  processed?: number | null;
  failed?: number | null;
  errorCodes?: string[];
  errorSample?: string | null;
  severity?: "INFO" | "WARN" | "ERROR";
};

export async function logStormwatchEvent(event: StormwatchEvent): Promise<void> {
  const doc = {
    timestamp: Timestamp.now(),
    orgId: event.orgId ?? null,
    source: event.source ?? null,
    function: event.function,
    kind: event.kind,
    rowsSent: event.rowsSent ?? null,
    accepted: event.accepted ?? null,
    rejected: event.rejected ?? null,
    processed: event.processed ?? null,
    failed: event.failed ?? null,
    errorCodes: event.errorCodes ?? [],
    errorSample: event.errorSample ?? null,
    severity: event.severity ?? "INFO",
  };

  await db.collection("stormwatch_events").add(doc);
}

export async function createSystemNotification(params: {
  type: "STORMWATCH" | "INGEST" | "SUBMISSION";
  severity: "INFO" | "WARN" | "ERROR";
  title: string;
  body: string;
  orgId?: string | null;
  relatedEventId?: string | null;
}): Promise<void> {
  await db.collection("system_notifications").add({
    createdAt: Timestamp.now(),
    type: params.type,
    severity: params.severity,
    title: params.title,
    body: params.body,
    orgId: params.orgId ?? null,
    acknowledgedBy: [],
    acknowledgedAt: null,
    relatedEventId: params.relatedEventId ?? null,
  });
}

function initSendgrid() {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn("[StormWatch] SENDGRID_API_KEY is not set; email disabled.");
    return null;
  }
  sendgrid.setApiKey(apiKey);
  return sendgrid;
}

export async function sendStormwatchEmail(options: {
  subject: string;
  text: string;
}): Promise<void> {
  const sg = initSendgrid();
  if (!sg) return;

  const toEnv = process.env.STORMWATCH_TO_EMAILS || "";
  const fromEnv =
    process.env.STORMWATCH_FROM_EMAIL || "stormwatch@example.com";

  const to = toEnv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => !!s);

  if (to.length === 0) {
    console.warn("[StormWatch] No STORMWATCH_TO_EMAILS configured; skipping.");
    return;
  }

  await sg.send({
    to,
    from: fromEnv,
    subject: options.subject,
    text: options.text,
  });
}
