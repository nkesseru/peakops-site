// src/submission/processQueuedSubmissions.ts

import { onRequest } from "firebase-functions/v2/https";
import { db, Timestamp } from "../firebase";
import { SubmissionQueueItem, SubmissionStatus } from "../types/submission";
import { MAX_SUBMISSION_ATTEMPTS } from "../config";
import { logSystemEvent } from "../logging";

// Stub external submission
async function sendSubmission(
  item: SubmissionQueueItem
): Promise<{ ok: boolean; error?: string }> {
  console.log(
    "Pretending to submit filing:",
    item.orgId,
    item.incidentId,
    item.filingType
  );

  // TODO: integrate real FCC/DOE call
  return { ok: true };
}

export const processQueuedSubmissions = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const { limit = 10 } = (req as any).body || {};
    const max =
      typeof limit === "number" && limit > 0 && limit <= 100 ? limit : 10;

    let query: FirebaseFirestore.Query = db
      .collection("submission_queue")
      .where("status", "==", "PENDING")
      .orderBy("createdAt", "asc")
      .limit(max);

    const snap = await query.get();

    if (snap.empty) {
      res.json({ success: true, processed: 0, updated: 0 });
      return;
    }

    let processed = 0;
    let updated = 0;

    for (const doc of snap.docs) {
      const data = doc.data() as SubmissionQueueItem;
      const ref = doc.ref;

      processed += 1;

      // Guard malformed queue items
      if (!data.orgId || !data.incidentId || !data.filingType) {
        console.warn("Skipping malformed queue item", doc.id);
        await ref.set(
          {
            status: "FAILED" as SubmissionStatus,
            lastError: "MALFORMED_QUEUE_ITEM",
            updatedAt: Timestamp.now(),
          },
          { merge: true }
        );
        updated += 1;
        continue;
      }

      await ref.set(
        {
          status: "IN_PROGRESS" as SubmissionStatus,
          updatedAt: Timestamp.now(),
        },
        { merge: true }
      );

      let newStatus: SubmissionStatus = "SUCCESS";
      let errorMessage: string | null = null;

      try {
        const result = await sendSubmission(data);

        if (!result.ok) {
          newStatus = "FAILED";
          errorMessage = result.error || "Unknown error from sendSubmission";
        }
      } catch (err: any) {
        console.error("Error in sendSubmission:", err);
        newStatus = "FAILED";
        errorMessage = err?.message || "Unhandled error in sendSubmission";
      }

      const attempts = (data.attempts || 0) + 1;
      let finalStatus: SubmissionStatus = newStatus;

      if (attempts >= MAX_SUBMISSION_ATTEMPTS && newStatus === "FAILED") {
        // Optional: dead-letter
        const dlRef = db
          .collection("submission_dead_letters")
          .doc(ref.id);
        await dlRef.set(
          {
            ...data,
            lastError: errorMessage,
            deadAt: Timestamp.now(),
          },
          { merge: true }
        );
        finalStatus = "FAILED";
      }

      await ref.set(
        {
          status: finalStatus,
          attempts,
          lastError: errorMessage || null,
          updatedAt: Timestamp.now(),
        },
        { merge: true }
      );

      updated += 1;
    }

    res.json({
      success: true,
      processed,
      updated,
    });
  } catch (error: any) {
    console.error("processQueuedSubmissions ERROR:", error);
    await logSystemEvent({
      level: "ERROR",
      subsystem: "QUEUE_WORKER",
      message: "Unhandled error in processQueuedSubmissions",
      data: { error: error?.message },
    });
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});
