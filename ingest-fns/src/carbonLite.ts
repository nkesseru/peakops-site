// ingest-fns/src/carbonLite.ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

if (getApps().length === 0) initializeApp();
const db = getFirestore();

const DEFAULT_FACTORS = {
  road_kg_per_mile: {
    light_gas: 0.40,
    light_diesel: 0.58,
    med_duty_diesel: 0.73,
    unknown: 0.50,
  },
  idle_kg_per_hour: {
    gas: 3.5,
    diesel: 6.1,
    unknown: 4.0,
  },
  grid_kg_per_kwh: 0.40,
};

type CarbonInputs = {
  orgId: string;
  workOrderId?: string;
  distance_miles?: number;
  vehicle_type?: "light_gas" | "light_diesel" | "med_duty_diesel" | "unknown";
  idle_minutes?: number;
  idle_fuel?: "gas" | "diesel" | "unknown";
  kwh_used_on_site?: number;
  activity_start_iso?: string;
  activity_end_iso?: string;
  override?: Partial<{
    road_kg_per_mile: number;
    idle_kg_per_hour: number;
    grid_kg_per_kwh: number;
  }>;
  notes?: string;
};

async function resolveFactors(orgId: string, input: CarbonInputs) {
  const oneOff = input.override ?? {};
  let orgFactors: any = {};
  try {
    const snap = await db.doc(`orgs/${orgId}/config/carbon_factors`).get();
    if (snap.exists) orgFactors = snap.data() ?? {};
  } catch (e) {
    logger.warn("carbonLite: unable to read org factors", e);
  }
  const vehicleKey = input.vehicle_type ?? "unknown";
  const idleKey = input.idle_fuel ?? "unknown";

  const road = oneOff.road_kg_per_mile
    ?? orgFactors.road_kg_per_mile?.[vehicleKey]
    ?? DEFAULT_FACTORS.road_kg_per_mile[vehicleKey];

  const idle = oneOff.idle_kg_per_hour
    ?? orgFactors.idle_kg_per_hour?.[idleKey]
    ?? DEFAULT_FACTORS.idle_kg_per_hour[idleKey];

  const grid = oneOff.grid_kg_per_kwh
    ?? orgFactors.grid_kg_per_kwh
    ?? DEFAULT_FACTORS.grid_kg_per_kwh;

  return { road_kg_per_mile: road, idle_kg_per_hour: idle, grid_kg_per_kwh: grid };
}

function assertOrg(input?: CarbonInputs) {
  if (!input?.orgId) throw new HttpsError("invalid-argument", "orgId is required");
}

function toDateOnlyUTC(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function calculateCO2e(
  input: CarbonInputs,
  factors: { road_kg_per_mile: number; idle_kg_per_hour: number; grid_kg_per_kwh: number }
) {
  const miles = Math.max(0, input.distance_miles ?? 0);
  const idleHours = Math.max(0, (input.idle_minutes ?? 0) / 60);
  const kwh = Math.max(0, input.kwh_used_on_site ?? 0);

  const road_kg = miles * factors.road_kg_per_mile;
  const idle_kg = idleHours * factors.idle_kg_per_hour;
  const grid_kg = kwh * factors.grid_kg_per_kwh;

  const total_kg = +(road_kg + idle_kg + grid_kg).toFixed(3);

  return {
    road_kg: +road_kg.toFixed(3),
    idle_kg: +idle_kg.toFixed(3),
    grid_kg: +grid_kg.toFixed(3),
    total_kg,
  };
}

export const computeCarbonLite = onCall<CarbonInputs>(async (req) => {
  const data = req.data;
  assertOrg(data);

  const factors = await resolveFactors(data.orgId, data);
  const calc = calculateCO2e(data, factors);

  const now = new Date();
  const start = data.activity_start_iso ? new Date(data.activity_start_iso) : now;
  const dayKey = toDateOnlyUTC(start);

  const payload = {
    orgId: data.orgId,
    workOrderId: data.workOrderId ?? null,
    inputs: {
      distance_miles: data.distance_miles ?? 0,
      vehicle_type: data.vehicle_type ?? "unknown",
      idle_minutes: data.idle_minutes ?? 0,
      idle_fuel: data.idle_fuel ?? "unknown",
      kwh_used_on_site: data.kwh_used_on_site ?? 0,
    },
    factors,
    results: calc,
    activity_start_iso: start.toISOString(),
    activity_end_iso: data.activity_end_iso ?? null,
    day_key_utc: dayKey,
    notes: data.notes ?? null,
    created_at: FieldValue.serverTimestamp(),
  };

  const ref = await db.collection(`orgs/${data.orgId}/carbon_estimates`).add(payload);

  await db.doc(`orgs/${data.orgId}/carbon_daily_summaries/${dayKey}`).set(
    {
      total_kg: FieldValue.increment(calc.total_kg),
      road_kg: FieldValue.increment(calc.road_kg),
      idle_kg: FieldValue.increment(calc.idle_kg),
      grid_kg: FieldValue.increment(calc.grid_kg),
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { id: ref.id, ...payload };
});

export const onCarbonEventCreated = onDocumentCreated(
  "orgs/{orgId}/carbon_events/{eventId}",
  async (event) => {
    const orgId = event.params.orgId as string;
    const data = event.data?.data() as Partial<CarbonInputs> | undefined;
    if (!data) return;

    const inputs: CarbonInputs = {
      orgId,
      workOrderId: (data as any).workOrderId,
      distance_miles: (data as any).distance_miles ?? 0,
      vehicle_type: (data as any).vehicle_type ?? "unknown",
      idle_minutes: (data as any).idle_minutes ?? 0,
      idle_fuel: (data as any).idle_fuel ?? "unknown",
      kwh_used_on_site: (data as any).kwh_used_on_site ?? 0,
      activity_start_iso: (data as any).activity_start_iso,
      activity_end_iso: (data as any).activity_end_iso,
      notes: (data as any).notes,
    };

    const factors = await resolveFactors(orgId, inputs);
    const calc = calculateCO2e(inputs, factors);
    const start = inputs.activity_start_iso ? new Date(inputs.activity_start_iso) : new Date();
    const dayKey = toDateOnlyUTC(start);

    const estimate = {
      orgId,
      source_event_id: event.params.eventId,
      workOrderId: inputs.workOrderId ?? null,
      inputs: {
        distance_miles: inputs.distance_miles ?? 0,
        vehicle_type: inputs.vehicle_type ?? "unknown",
        idle_minutes: inputs.idle_minutes ?? 0,
        idle_fuel: inputs.idle_fuel ?? "unknown",
        kwh_used_on_site: inputs.kwh_used_on_site ?? 0,
      },
      factors,
      results: calc,
      activity_start_iso: start.toISOString(),
      activity_end_iso: inputs.activity_end_iso ?? null,
      day_key_utc: dayKey,
      created_at: FieldValue.serverTimestamp(),
    };

    const ref = await db.collection(`orgs/${orgId}/carbon_estimates`).add(estimate);

    await db.doc(`orgs/${orgId}/carbon_daily_summaries/${dayKey}`).set(
      {
        total_kg: FieldValue.increment(calc.total_kg),
        road_kg: FieldValue.increment(calc.road_kg),
        idle_kg: FieldValue.increment(calc.idle_kg),
        grid_kg: FieldValue.increment(calc.grid_kg),
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    logger.info(`carbonLite: computed from event ${event.params.eventId} -> estimate ${ref.id}`);
  }
);

export const rebuildYesterdaySummary = onSchedule("0 8 * * *", async (event) => {
  const now = new Date();
  const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dayKey = toDateOnlyUTC(y);

  const orgsSnap = await db.collection("orgs").select().get();

  for (const org of orgsSnap.docs) {
    const orgId = org.id;
    const estSnap = await db
      .collection(`orgs/${orgId}/carbon_estimates`)
      .where("day_key_utc", "==", dayKey)
      .get();

    let road = 0, idle = 0, grid = 0, total = 0;
    estSnap.forEach((d) => {
      const r = d.get("results");
      if (!r) return;
      road += r.road_kg || 0;
      idle += r.idle_kg || 0;
      grid += r.grid_kg || 0;
      total += r.total_kg || 0;
    });

    await db.doc(`orgs/${orgId}/carbon_daily_summaries/${dayKey}`).set(
      {
        road_kg: +road.toFixed(3),
        idle_kg: +idle.toFixed(3),
        grid_kg: +grid.toFixed(3),
        total_kg: +total.toFixed(3),
        rebuilt_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  logger.info("carbonLite: rebuilt yesterday summaries", { dayKey });
});

export const rebuildCarbonSummary = onCall<{
  orgId: string;
  start_day_utc: string;
  end_day_utc: string;
}>(async (req) => {
  const { orgId, start_day_utc, end_day_utc } = req.data || ({} as any);
  if (!orgId || !start_day_utc || !end_day_utc) {
    throw new HttpsError("invalid-argument", "orgId, start_day_utc, end_day_utc are required");
  }

  const estSnap = await db
    .collection(`orgs/${orgId}/carbon_estimates`)
    .where("day_key_utc", ">=", start_day_utc)
    .where("day_key_utc", "<=", end_day_utc)
    .get();

  const buckets = new Map<string, { road: number; idle: number; grid: number; total: number }>();
  estSnap.forEach((d) => {
    const day = d.get("day_key_utc");
    const r = d.get("results") || {};
    const b = buckets.get(day) || { road: 0, idle: 0, grid: 0, total: 0 };
    b.road += r.road_kg || 0;
    b.idle += r.idle_kg || 0;
    b.grid += r.grid_kg || 0;
    b.total += r.total_kg || 0;
    buckets.set(day, b);
  });

  for (const [day, b] of buckets) {
    await db.doc(`orgs/${orgId}/carbon_daily_summaries/${day}`).set(
      {
        road_kg: +b.road.toFixed(3),
        idle_kg: +b.idle.toFixed(3),
        grid_kg: +b.grid.toFixed(3),
        total_kg: +b.total.toFixed(3),
        rebuilt_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return { ok: true, days_updated: Array.from(buckets.keys()).sort() };
});
