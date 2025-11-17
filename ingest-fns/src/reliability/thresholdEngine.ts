// src/reliability/thresholdEngine.ts

import { onRequest } from "firebase-functions/v2/https";
import { db, Timestamp } from "../firebase";
import {
  ReliabilityMetric,
  ReliabilityConfig,
  ReliabilityAlert,
  ReliabilityStatus,
} from "../types/reliability";

function evalStatus(
  value: number | null,
  warning: number,
  critical: number
): ReliabilityStatus {
  if (value === null || isNaN(value)) return "OK";
  if (value >= critical) return "CRITICAL";
  if (value >= warning) return "WARN";
  return "OK";
}

function combineOverall(
  saidiStatus: ReliabilityStatus,
  saifiStatus: ReliabilityStatus,
  caidiStatus: ReliabilityStatus
): ReliabilityStatus {
  const statuses = [saidiStatus, saifiStatus, caidiStatus];
  if (statuses.includes("CRITICAL")) return "CRITICAL";
  if (statuses.includes("WARN")) return "WARN";
  return "OK";
}

export const runReliabilityThresholds = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const { orgId, year } = (req as any).body || {};

    if (!orgId) {
      res.status(400).json({ error: "MISSING_ORG_ID" });
      return;
    }

    const configSnap = await db
      .collection("reliability_configs")
      .doc(orgId)
      .get();

    if (!configSnap.exists) {
      res.status(400).json({ error: "CONFIG_NOT_FOUND", orgId });
      return;
    }

    const config = configSnap.data() as ReliabilityConfig;

    let query: FirebaseFirestore.Query = db
      .collection("reliability_metrics")
      .where("orgId", "==", orgId);

    if (year) {
      query = query.where("year", "==", year);
    }

    const metricsSnap = await query.get();

    if (metricsSnap.empty) {
      res.json({ success: true, processed: 0, alertsCreated: 0 });
      return;
    }

    const batch = db.batch();
    let processed = 0;
    let alertsCreated = 0;
    const now = Timestamp.now();

    metricsSnap.forEach((doc) => {
      const metric = doc.data() as ReliabilityMetric;

      const saidiStatus = evalStatus(
        metric.saidiHours,
        config.saidiWarningHours,
        config.saidiCriticalHours
      );
      const saifiStatus = evalStatus(
        metric.saifiInterruptions,
        config.saifiWarning,
        config.saifiCritical
      );
      const caidiStatus = evalStatus(
        metric.caidiHours,
        config.caidiWarningHours,
        config.caidiCriticalHours
      );

      const overallStatus = combineOverall(
        saidiStatus,
        saifiStatus,
        caidiStatus
      );

      const metricRef = doc.ref;

      const update: Partial<ReliabilityMetric> = {
        saidiStatus,
        saifiStatus,
        caidiStatus,
        overallStatus,
      };

      batch.set(metricRef, update, { merge: true });
      processed += 1;

      // Only log alerts if not MUTE and something is off
      if (config.alertingMode !== "MUTE" && overallStatus !== "OK") {
        const alertRef = db.collection("reliability_alerts").doc();
        const alert: ReliabilityAlert = {
          orgId: metric.orgId,
          metricId: metric.metricId,
          regionId: metric.regionId,
          year: metric.year,
          saidiStatus,
          saifiStatus,
          caidiStatus,
          overallStatus,
          createdAt: now,
          createdBy: "SYSTEM",
          source: "THRESHOLD_ENGINE",
        };
        batch.set(alertRef, alert);
        alertsCreated += 1;
      }
    });

    await batch.commit();

    res.json({
      success: true,
      processed,
      alertsCreated,
    });
  } catch (error) {
    console.error("runReliabilityThresholds ERROR:", error);
    res.status(500).json({ error: "SERVER_ERROR" });
  }
});
