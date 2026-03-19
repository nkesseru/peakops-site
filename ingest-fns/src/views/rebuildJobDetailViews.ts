// src/views/rebuildJobDetailViews.ts

import { onRequest } from "firebase-functions/v2/https";
import { db, Timestamp } from "../firebase";
import { JobDetailView } from "../types/jobDetailView";

/**
 * One-time rebuild of ALL job_detail_views docs.
 * Useful after adding fields or making schema changes.
 */
export const rebuildJobDetailViews = onRequest(async (_req, res) => {
  try {
    const jobsSnap = await db.collection("jobs").get();
    let rebuilt = 0;

    for (const doc of jobsSnap.docs) {
      const jobId = doc.id;
      const jobData = doc.data() || {};
      const orgId = jobData.orgId || "default-org";
      const locationId = jobData.locationId || null;

      // ---- LOAD LOCATION SNAPSHOT ----
      let locationName: string | null = null;
      let locationAddress: string | null = null;
      let locationCity: string | null = null;
      let locationState: string | null = null;
      let locationLat: number | null = null;
      let locationLng: number | null = null;

      if (locationId) {
        const locSnap = await db.collection("locations").doc(locationId).get();
        if (locSnap.exists) {
          const loc = locSnap.data() || {};
          locationName = loc.name || null;
          locationAddress = loc.address || null;
          locationCity = loc.city || null;
          locationState = loc.state || null;
          locationLat = typeof loc.lat === "number" ? loc.lat : null;
          locationLng = typeof loc.lng === "number" ? loc.lng : null;
        }
      }

      // ---- BUILD VIEW DOC ----
      const view: JobDetailView = {
        jobId,
        orgId,

        status: jobData.status || null,
        workOrderId: jobData.workOrderId || null,
        ptpId: jobData.ptpId || null,
        scheduledStart: jobData.scheduledStart || null,
        scheduledEnd: jobData.scheduledEnd || null,
        crewAssigned: jobData.crewAssigned || null,

        locationId,
        locationName,
        locationAddress,
        locationCity,
        locationState,
        locationLat,
        locationLng,

        lastInspectionAt: jobData.lastInspectionAt || null,
        openIssuesCount:
          typeof jobData.openIssuesCount === "number"
            ? jobData.openIssuesCount
            : null,
        notesPreview: jobData.notesPreview || null,

        updatedAt: Timestamp.now(),
      };

      await db
        .collection("job_detail_views")
        .doc(jobId)
        .set(view, { merge: true });

      rebuilt++;
    }

    res.json({
      success: true,
      rebuilt,
    });
  } catch (err: any) {
    console.error("rebuildJobDetailViews ERROR:", err);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: err?.message,
    });
  }
});
