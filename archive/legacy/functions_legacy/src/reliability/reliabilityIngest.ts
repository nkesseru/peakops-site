// src/reliability/reliabilityIngest.ts

import { onRequest } from "firebase-functions/v2/https";
import { db, Timestamp } from "../firebase";
import {
  ReliabilityMetric,
  ReliabilityIngestRaw,
  makeMetricId,
} from "../types/reliability";

type ValidationResult =
  | Pick<
      ReliabilityMetric,
      "year" | "saidiHours" | "saifiInterruptions" | "caidiHours" | "dataQuality"
    >
  | { error: string };

function validateReliabilityRow(raw: any): ValidationResult {
  const currentYear = new Date().getFullYear();

  const year = parseInt(raw.year);
  if (!year || year < 1990 || year > currentYear) {
    return { error: "INVALID_YEAR" };
  }

  const saidi = raw.saidi !== undefined ? parseFloat(raw.saidi) : NaN;
  const saifi = raw.saifi !== undefined ? parseFloat(raw.saifi) : NaN;
  const caidi = raw.caidi !== undefined ? parseFloat(raw.caidi) : NaN;

  const saidiHours = isNaN(saidi) ? null : saidi;
  const saifiInterruptions = isNaN(saifi) ? null : saifi;
  const caidiHours = isNaN(caidi) ? null : caidi;

  if (
    saidiHours === null &&
    saifiInterruptions === null &&
    caidiHours === null
  ) {
    return { error: "NO_METRICS_FOUND" };
  }

  const tooLarge = (v: number | null) => v !== null && v > 8760;
  const isBad =
    tooLarge(saidiHours) || tooLarge(saifiInterruptions) || tooLarge(caidiHours);

  const dataQuality = isBad ? "BAD" : "GOOD";

  return {
    year,
    saidiHours,
    saifiInterruptions,
    caidiHours,
    dataQuality,
  };
}

export const reliabilityIngest = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    }

    const {
      orgId,
      source,
      rows,
      regionId = "SYSTEM",
      importedBy = "SYSTEM",
      sourceFileName,
    } = req.body || {};

    if (!orgId || !Array.isArray(rows) || !source) {
      return res.status(400).json({ error: "INVALID_REQUEST" });
    }

    const batch = db.batch();
    const now = Timestamp.now();

    let accepted = 0;
    let rejected = 0;

    for (const raw of rows) {
      const parsed = validateReliabilityRow(raw);
      const rawRef = db.collection("reliability_ingest_raw").doc();

      if ("error" in parsed) {
        const ingestRaw: ReliabilityIngestRaw = {
          orgId,
          regionId,
          rawRow: raw,
          parsed: null,
          status: "REJECTED",
          errorCode: parsed.error,
          errorMessage: "Validation failed",
          importedAt: now,
          importedBy,
          source,
          sourceFileName,
        };
        batch.set(rawRef, ingestRaw);
        rejected += 1;
        continue;
      }

      const { year, saidiHours, saifiInterruptions, caidiHours, dataQuality } =
        parsed;

      const metricId = makeMetricId(orgId, regionId, year, source);
      const metricRef = db.collection("reliability_metrics").doc(metricId);

      const normalizedRecord: Partial<ReliabilityMetric> = {
        orgId,
        regionId,
        year,
        source,
        metricId,
        saidiHours,
        saifiInterruptions,
        caidiHours,
        dataQuality,
        importedAt: now,
        importedBy,
        sourceFileName,
      };

      const ingestRaw: ReliabilityIngestRaw = {
        orgId,
        regionId,
        year,
        rawRow: raw,
        parsed: normalizedRecord as ReliabilityMetric,
        status: "ACCEPTED",
        importedAt: now,
        importedBy,
        source,
        sourceFileName,
      };

      batch.set(rawRef, ingestRaw);
      batch.set(metricRef, normalizedRecord, { merge: true });

      accepted += 1;
    }

    await batch.commit();

    return res.json({
      success: true,
      accepted,
      rejected,
    });
  } catch (error) {
    console.error("reliabilityIngest ERROR:", error);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
});
