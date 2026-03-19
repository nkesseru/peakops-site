// src/reliability/reliabilityIngest.ts

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { logStormwatchEvent } from "../stormwatch";

const db = getFirestore();

const INGEST_API_KEY = process.env.INGEST_API_KEY;
const MAX_INGEST_ROWS = Number(process.env.MAX_INGEST_ROWS ?? "1000");

// ----- Types & helpers -----

type DataQuality = "GOOD" | "BAD";

type ValidReliabilityRow = {
  year: number;
  saidiHours: number;
  saifiInterruptions: number;
  caidiHours: number;
  dataQuality: DataQuality;
};

type ValidationError = {
  error: string;
  message: string;
};

type ValidationResult = ValidReliabilityRow | ValidationError;

type RawReliabilityRow = {
  year?: number | string;
  saidi?: number | string;
  saifi?: number | string;
  caidi?: number | string;
  [key: string]: any;
};

function normalizeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Validate and normalize a single reliability row.
 */
function validateReliabilityRow(raw: RawReliabilityRow, index: number): ValidationResult {
  const yearNum = normalizeNumber(raw.year);
  const saidi = normalizeNumber(raw.saidi);
  const saifi = normalizeNumber(raw.saifi);
  const caidi = normalizeNumber(raw.caidi);

  if (yearNum === null || !Number.isInteger(yearNum)) {
    return {
      error: "INVALID_YEAR",
      message: `Row ${index}: 'year' is missing or not an integer`,
    };
  }

  if (yearNum < 1990 || yearNum > 2100) {
    return {
      error: "YEAR_OUT_OF_RANGE",
      message: `Row ${index}: 'year' (${yearNum}) is out of allowed range (1990–2100)`,
    };
  }

  if (saidi === null || saifi === null || caidi === null) {
    return {
      error: "MISSING_METRICS",
      message: `Row ${index}: one or more metrics (saidi, saifi, caidi) are missing or invalid`,
    };
  }

  if (saidi < 0 || saifi < 0 || caidi < 0) {
    return {
      error: "NEGATIVE_METRICS",
      message: `Row ${index}: metrics cannot be negative (saidi=${saidi}, saifi=${saifi}, caidi=${caidi})`,
    };
  }

  // Simple data quality heuristic – you can refine this
  const isBad =
    saidi > 1000 || saifi > 100 || caidi > 100 || Number.isNaN(saidi) || Number.isNaN(saifi) || Number.isNaN(caidi);

  const dataQuality: DataQuality = isBad ? "BAD" : "GOOD";

  return {
    year: yearNum,
    saidiHours: saidi,
    saifiInterruptions: saifi,
    caidiHours: caidi,
    dataQuality,
  };
}

/**
 * Make a stable metric ID. Adjust if you want a different key strategy.
 */
function makeMetricId(orgId: string, regionId: string, year: number): string {
  return `${orgId}_${regionId}_${year}`;
}

// ----- Main function -----

export const reliabilityIngest = onRequest(async (req, res) => {
  try {
    // --- Auth / method checks ---
    const headerKey = req.get("x-peakops-key");
    if (!INGEST_API_KEY || headerKey !== INGEST_API_KEY) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const {
      orgId,
      source,
      rows,
      regionId = "SYSTEM",
      importedBy = "SYSTEM",
      sourceFileName,
    } = (req as any).body || {};

    if (!orgId || typeof orgId !== "string") {
      res.status(400).json({ error: "MISSING_ORG_ID" });
      return;
    }

    if (!source || typeof source !== "string") {
      res.status(400).json({ error: "MISSING_SOURCE" });
      return;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: "NO_ROWS" });
      return;
    }

    if (rows.length > MAX_INGEST_ROWS) {
      res.status(413).json({ error: "TOO_MANY_ROWS", max: MAX_INGEST_ROWS });
      return;
    }

    const safeSourceFileName =
      typeof sourceFileName === "string" && sourceFileName.length > 0
        ? sourceFileName
        : null;

    // --- Validate rows & build accepted/rejected sets ---

    const accepted: ValidReliabilityRow[] = [];
    const rejected: ValidationError[] = [];

    (rows as RawReliabilityRow[]).forEach((raw, index) => {
      const result = validateReliabilityRow(raw, index);
      if ("error" in result) {
        rejected.push(result);
      } else {
        accepted.push(result);
      }
    });

    // --- Write accepted metrics to Firestore ---

    const batch = db.batch();
    const now = Timestamp.now();

    for (const metric of accepted) {
      const metricId = makeMetricId(orgId, regionId, metric.year);
      const ref = db.collection("reliabilityMetrics").doc(metricId);

      const doc = {
        orgId,
        regionId,
        metricId,
        importedBy,
        source,
        sourceFileName: safeSourceFileName,
        createdAt: now,
        updatedAt: now,
        year: metric.year,
        saidiHours: metric.saidiHours,
        saifiInterruptions: metric.saifiInterruptions,
        caidiHours: metric.caidiHours,
        dataQuality: metric.dataQuality,
      };

      batch.set(ref, doc, { merge: true });
    }

    if (accepted.length > 0) {
      await batch.commit();
    }

    const rowsSent = rows.length;
    const acceptedCount = accepted.length;
    const rejectedCount = rejected.length;

    // --- StormWatch logging ---

    const errorCodes = Array.from(new Set(rejected.map((r) => r.error)));

    await logStormwatchEvent({
      orgId,
      source,
      function: "reliabilityIngest",
      kind: "INGEST_RUN",
      rowsSent,
      accepted: acceptedCount,
      rejected: rejectedCount,
      errorCodes,
      errorSample: rejectedCount > 0 ? rejected[0].message : null,
      severity:
        rejectedCount === 0
          ? "INFO"
          : rejectedCount <= 5
          ? "WARN"
          : "ERROR",
    });

    // --- Response ---

    res.json({
      success: true,
      accepted: acceptedCount,
      rejected: rejectedCount,
    });
  } catch (err: any) {
    console.error("[reliabilityIngest] Unexpected error", err);

    // Best effort StormWatch log on hard failure
    try {
      await logStormwatchEvent({
        orgId: null,
        source: "reliabilityIngest",
        function: "reliabilityIngest",
        kind: "INGEST_RUN",
        rowsSent: null,
        accepted: null,
        rejected: null,
        errorCodes: ["UNEXPECTED_ERROR"],
        errorSample: err?.message ?? String(err),
        severity: "ERROR",
      });
    } catch (logErr) {
      console.error("[reliabilityIngest] Failed to log StormWatch event", logErr);
    }

    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
